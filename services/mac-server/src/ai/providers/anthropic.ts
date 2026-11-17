import Anthropic from '@anthropic-ai/sdk';
import {
  isAbort,
  providerError,
  ProviderError,
  type AIProvider,
  type AiTextRequest,
  type AiTextResult,
} from '../provider.js';

/**
 * Models that accept server-side refusal fallbacks (`fallbacks: "default"`,
 * beta `server-side-fallback-2026-07-01`). On a policy decline the API reruns
 * the request on a fallback model in the same call; `response.model` then
 * names the model that served it, and cost is priced from that.
 */
const FALLBACK_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
  'claude-fable-5-2',
]);

export interface AdapterOptions {
  /** Override the API origin, e.g. a local fake server in tests. */
  baseUrl?: string | undefined;
  timeoutMs: number;
}

/** Claude via the official `@anthropic-ai/sdk` (Messages API). */
export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;

  constructor(private readonly options: AdapterOptions) {}

  async generateText(req: AiTextRequest, apiKey: string): Promise<AiTextResult> {
    const client = new Anthropic({
      apiKey,
      ...(this.options.baseUrl === undefined ? {} : { baseURL: this.options.baseUrl }),
      // The AI job runner owns retries and backoff.
      maxRetries: 0,
      timeout: this.options.timeoutMs,
    });
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          ...(req.system === undefined ? {} : { system: req.system }),
          messages: [{ role: 'user', content: req.prompt }],
          ...(req.jsonSchema === undefined
            ? {}
            : { output_config: { format: { type: 'json_schema', schema: req.jsonSchema } } }),
          ...(FALLBACK_MODELS.has(req.model)
            ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
            : {}),
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw classify(err, req.signal);
    }
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? null;
      throw providerError(
        'content_blocked',
        category === null ? undefined : `category ${category}`,
      );
    }
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    return {
      text,
      model: response.model,
      usage: {
        input_tokens:
          response.usage.input_tokens +
          (response.usage.cache_creation_input_tokens ?? 0) +
          (response.usage.cache_read_input_tokens ?? 0),
        output_tokens: response.usage.output_tokens,
      },
      finish:
        response.stop_reason === 'max_tokens' ||
        response.stop_reason === 'model_context_window_exceeded'
          ? 'max_tokens'
          : 'stop',
    };
  }
}

function classify(err: unknown, signal: AbortSignal): Error {
  if (isAbort(err, signal) || err instanceof Anthropic.APIUserAbortError) {
    return err instanceof Error ? err : new Error('aborted');
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return providerError('timeout');
  if (err instanceof Anthropic.APIConnectionError) return providerError('provider_unavailable');
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return statusError(err.status, apiMessage(err.error));
  }
  return err instanceof ProviderError ? err : providerError('unknown');
}

/** `529 overloaded_error` is an unavailable provider, like other 5xx. */
function statusError(status: number, detail: string | undefined): ProviderError {
  if (status === 401 || status === 403) return providerError('invalid_key', undefined, status);
  if (status === 429) return providerError('rate_limited', undefined, status);
  if (status >= 500) return providerError('provider_unavailable', detail, status);
  return providerError('bad_request', detail, status);
}

function apiMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const inner = body.error;
  if (typeof inner === 'object' && inner !== null && 'message' in inner) {
    return typeof inner.message === 'string' ? inner.message : undefined;
  }
  return undefined;
}
