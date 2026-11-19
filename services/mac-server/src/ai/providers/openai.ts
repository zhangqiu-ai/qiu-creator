import OpenAI from 'openai';
import {
  codeForStatus,
  isAbort,
  providerError,
  ProviderError,
  type AIProvider,
  type AiTextRequest,
  type AiTextResult,
} from '../provider.js';
import type { AdapterOptions } from './anthropic.js';

/** GPT via the official `openai` SDK (Responses API). */
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;

  constructor(private readonly options: AdapterOptions) {}

  async generateText(req: AiTextRequest, apiKey: string): Promise<AiTextResult> {
    const client = new OpenAI({
      apiKey,
      // The base URL includes the version path, e.g. `https://api.openai.com/v1`.
      ...(this.options.baseUrl === undefined ? {} : { baseURL: this.options.baseUrl }),
      maxRetries: 0,
      timeout: this.options.timeoutMs,
    });
    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create(
        {
          model: req.model,
          input: req.prompt,
          max_output_tokens: req.maxOutputTokens,
          ...(req.system === undefined ? {} : { instructions: req.system }),
          ...(req.jsonSchema === undefined
            ? {}
            : {
                text: {
                  format: {
                    type: 'json_schema',
                    name: 'result',
                    schema: req.jsonSchema,
                    strict: true,
                  },
                },
              }),
          // Do not keep the conversation on OpenAI's side.
          store: false,
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw classify(err, req.signal);
    }

    const parts: string[] = [];
    for (const item of response.output) {
      if (item.type !== 'message') continue;
      for (const content of item.content) {
        if (content.type === 'refusal') throw providerError('content_blocked');
        else parts.push(content.text);
      }
    }
    const reason = response.incomplete_details?.reason;
    if (reason === 'content_filter') throw providerError('content_blocked');
    return {
      text: parts.join(''),
      model: response.model,
      usage: {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
      },
      finish: reason === 'max_output_tokens' ? 'max_tokens' : 'stop',
    };
  }
}

/** New API via its OpenAI-compatible Chat Completions endpoint. */
export class NewApiProvider implements AIProvider {
  readonly id = 'new-api' as const;

  constructor(private readonly options: AdapterOptions) {}

  async generateText(req: AiTextRequest, apiKey: string, baseUrl?: string): Promise<AiTextResult> {
    const baseURL = this.options.baseUrl ?? baseUrl;
    if (baseURL === undefined) throw providerError('missing_key');
    const client = new OpenAI({
      apiKey,
      baseURL,
      organization: null,
      project: null,
      maxRetries: 0,
      timeout: this.options.timeoutMs,
      fetchOptions: { redirect: 'error' },
    });
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await client.chat.completions.create(
        {
          model: req.model,
          max_completion_tokens: req.maxOutputTokens,
          messages: [
            ...(req.system === undefined ? [] : [{ role: 'system' as const, content: req.system }]),
            { role: 'user', content: req.prompt },
          ],
          ...(req.jsonSchema === undefined
            ? {}
            : {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: 'result', schema: req.jsonSchema, strict: true },
                },
              }),
        },
        { signal: req.signal },
      );
    } catch (err) {
      if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
        // The relay's error may echo the configured URL or request content.
        throw providerError(codeForStatus(err.status), undefined, err.status);
      }
      throw classify(err, req.signal);
    }

    const choice = response.choices[0];
    if (choice?.finish_reason === 'content_filter' || choice?.message.refusal) {
      throw providerError('content_blocked');
    }
    if (typeof choice?.message.content !== 'string' || choice.message.content.length === 0) {
      throw providerError('invalid_output');
    }
    return {
      text: choice.message.content,
      model: response.model || req.model,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
      finish: choice.finish_reason === 'length' ? 'max_tokens' : 'stop',
    };
  }
}

function classify(err: unknown, signal: AbortSignal): Error {
  if (isAbort(err, signal) || err instanceof OpenAI.APIUserAbortError) {
    return err instanceof Error ? err : new Error('aborted');
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) return providerError('timeout');
  if (err instanceof OpenAI.APIConnectionError) return providerError('provider_unavailable');
  if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
    const status = err.status;
    if (status === 401 || status === 403) return providerError('invalid_key', undefined, status);
    if (status === 429) return providerError('rate_limited', undefined, status);
    if (status >= 500) return providerError('provider_unavailable', undefined, status);
    return providerError('bad_request', err.message, status);
  }
  return err instanceof ProviderError ? err : providerError('unknown');
}
