import { ApiError, GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import {
  isAbort,
  providerError,
  ProviderError,
  type AIProvider,
  type AiTextRequest,
  type AiTextResult,
} from '../provider.js';
import type { AdapterOptions } from './anthropic.js';
import { effectiveTimeout, fetchModelList } from './relay-models.js';

/** Finish reasons that mean the content was blocked rather than completed. */
const BLOCKED_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
]);

/** Gemini via the official `@google/genai` SDK (Gemini Developer API, `generateContent`). */
export class GeminiProvider implements AIProvider {
  readonly id = 'gemini' as const;

  constructor(private readonly options: AdapterOptions) {}

  /** `GET /v1beta/models` (QC-057 connection test); free, sends no content. Ids drop `models/`. */
  listModels(apiKey: string, _baseUrl?: string, timeoutMs?: number): Promise<string[]> {
    const origin = (this.options.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
      /\/+$/,
      '',
    );
    return fetchModelList({
      url: `${origin}/v1beta/models?pageSize=1000`,
      headers: { 'x-goog-api-key': apiKey },
      timeoutMs: effectiveTimeout(this.options.timeoutMs, timeoutMs),
      listKey: 'models',
      idKey: 'name',
    });
  }

  async generateText(req: AiTextRequest, apiKey: string): Promise<AiTextResult> {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl }),
        timeout: this.options.timeoutMs,
        // The AI job runner owns retries; one attempt here.
        retryOptions: { attempts: 1 },
      },
    });
    let response: GenerateContentResponse;
    try {
      response = await ai.models.generateContent({
        model: req.model,
        contents: req.prompt,
        config: {
          maxOutputTokens: req.maxOutputTokens,
          abortSignal: req.signal,
          ...(req.system === undefined ? {} : { systemInstruction: req.system }),
          ...(req.jsonSchema === undefined
            ? {}
            : { responseMimeType: 'application/json', responseJsonSchema: req.jsonSchema }),
        },
      });
    } catch (err) {
      throw classify(err, req.signal);
    }

    return toTextResult(response, req.model);
  }
}

/** Provider-neutral result from a `generateContent` response (blocked content throws). */
export function toTextResult(
  response: GenerateContentResponse,
  requestedModel: string,
): AiTextResult {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason !== undefined) {
    throw providerError('content_blocked', `prompt ${blockReason}`);
  }
  const candidate = response.candidates?.[0];
  const finish: string | undefined = candidate?.finishReason;
  if (finish !== undefined && BLOCKED_FINISH.has(finish)) {
    throw providerError('content_blocked', finish);
  }
  const text = (candidate?.content?.parts ?? [])
    .flatMap((part) => (part.thought === true || part.text === undefined ? [] : [part.text]))
    .join('');
  const usage = response.usageMetadata;
  return {
    text,
    model: response.modelVersion ?? requestedModel,
    usage: {
      input_tokens: usage?.promptTokenCount ?? 0,
      // Thinking tokens are billed as output.
      output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    },
    finish: finish === 'MAX_TOKENS' ? 'max_tokens' : 'stop',
  };
}

/** Map an SDK error to a classified `ProviderError` (aborts pass through). */
export function classify(err: unknown, signal: AbortSignal): Error {
  if (isAbort(err, signal)) return err instanceof Error ? err : new Error('aborted');
  // The SDK enforces `httpOptions.timeout` with its own AbortController: an
  // AbortError while our signal is not aborted is a timeout.
  if (err instanceof Error && err.name === 'AbortError') return providerError('timeout');
  if (err instanceof ApiError) {
    const status = err.status;
    // Gemini answers an invalid key with 400 API_KEY_INVALID.
    if (
      status === 401 ||
      status === 403 ||
      (status === 400 && /API_KEY_INVALID|API key not valid/i.test(err.message))
    ) {
      return providerError('invalid_key', undefined, status);
    }
    if (status === 429) return providerError('rate_limited', undefined, status);
    if (status >= 500) return providerError('provider_unavailable', undefined, status);
    return providerError('bad_request', undefined, status);
  }
  if (err instanceof Error && /timed?\s*out|timeout/i.test(`${err.name} ${err.message}`)) {
    return providerError('timeout');
  }
  if (err instanceof TypeError) return providerError('provider_unavailable');
  return err instanceof ProviderError ? err : providerError('unknown');
}
