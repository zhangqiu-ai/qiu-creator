import { AI_IMAGE_MAX_BYTES, AI_IMAGE_MAX_COUNT, type AiUsage } from '@qiu-creator/contracts';
import { codeForStatus, isAbort, providerError, ProviderError } from '../provider.js';

/** One `images/generations` call (QC-070). */
export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n: number;
  /** `WIDTHxHEIGHT`, e.g. `1024x1536`. */
  size: string;
  signal: AbortSignal;
}

/** An image as the relay returned it: inline (`b64_json`) or to fetch (`url`). */
export type GeneratedImage = { kind: 'bytes'; data: Buffer } | { kind: 'url'; url: string };

export interface ImageGenerationResult {
  images: GeneratedImage[];
  /** Token usage when the relay reports it (gpt-image models do); null otherwise. */
  usage: AiUsage | null;
}

/** Longest a generation may take before it counts as `timeout`. */
export const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
/** Largest JSON body read from the relay: every image inline as base64, plus some slack. */
const MAX_RESPONSE_BYTES = Math.ceil((AI_IMAGE_MAX_BYTES * AI_IMAGE_MAX_COUNT * 4) / 3) + 64 * 1024;

export interface NewApiImageOptions {
  /** Tests: the relay to call instead of the stored Base URL. */
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * New API image generation: `POST {base_url}/images/generations` with the
 * stored key (OpenAI-compatible). The key goes only to the relay, in the
 * Authorization header; redirects are refused so it cannot follow one
 * elsewhere, and no error carries the key, the URL, the prompt or the body.
 */
export class NewApiImageClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: NewApiImageOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS;
  }

  /** The relay actually called: the test override, else the stored Base URL. */
  base(storedBaseUrl: string | undefined): string {
    const base = this.options.baseUrl ?? storedBaseUrl;
    if (base === undefined) throw providerError('missing_key');
    return base.replace(/\/+$/, '');
  }

  async generate(
    req: ImageGenerationRequest,
    apiKey: string,
    storedBaseUrl: string | undefined,
  ): Promise<ImageGenerationResult> {
    const url = `${this.base(storedBaseUrl)}/images/generations`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ model: req.model, prompt: req.prompt, n: req.n, size: req.size }),
        redirect: 'error',
        signal,
      });
    } catch (err) {
      throw classify(err, req.signal, timeout);
    }
    let text: string;
    try {
      text = await readLimited(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      throw classify(err, req.signal, timeout);
    }
    if (!res.ok) throw failure(res.status, text);
    return parseImages(text, req.n);
  }
}

function classify(err: unknown, user: AbortSignal, timeout: AbortSignal): Error {
  if (err instanceof ProviderError) return err;
  if (isAbort(err, user)) return err instanceof Error ? err : new Error('aborted');
  if (timeout.aborted) return providerError('timeout');
  return providerError('provider_unavailable');
}

/** A relay error: the status, plus its error code when it is a content-policy refusal. */
function failure(status: number, body: string): ProviderError {
  const code = errorCode(body);
  if (code !== null && /content_policy|moderation|safety|blocked/i.test(code)) {
    return providerError('content_blocked', undefined, status);
  }
  // The body may echo the prompt or the URL: only a short error code is kept.
  return providerError(codeForStatus(status), code ?? undefined, status);
}

function errorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const error: unknown = Reflect.get(parsed, 'error');
    if (typeof error !== 'object' || error === null) return null;
    const code: unknown = Reflect.get(error, 'code') ?? Reflect.get(error, 'type');
    return typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

function parseImages(body: string, asked: number): ImageGenerationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw providerError('invalid_output', 'the relay did not answer JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw providerError('invalid_output');
  const data: unknown = Reflect.get(parsed, 'data');
  if (!Array.isArray(data) || data.length === 0) {
    throw providerError('invalid_output', 'no images in the answer');
  }
  const images: GeneratedImage[] = [];
  for (const item of data.slice(0, asked)) {
    if (typeof item !== 'object' || item === null) continue;
    const b64: unknown = Reflect.get(item, 'b64_json');
    const url: unknown = Reflect.get(item, 'url');
    if (typeof b64 === 'string' && b64 !== '') {
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > AI_IMAGE_MAX_BYTES) {
        throw providerError('invalid_output', 'an image is larger than the limit');
      }
      images.push({ kind: 'bytes', data: bytes });
    } else if (typeof url === 'string' && url !== '') {
      images.push({ kind: 'url', url });
    }
  }
  if (images.length === 0) throw providerError('invalid_output', 'no usable images in the answer');
  return { images, usage: usageOf(Reflect.get(parsed, 'usage')) };
}

function usageOf(raw: unknown): AiUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const input: unknown = Reflect.get(raw, 'input_tokens');
  const output: unknown = Reflect.get(raw, 'output_tokens');
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  if (!Number.isInteger(input) || !Number.isInteger(output) || input < 0 || output < 0) {
    return null;
  }
  return { input_tokens: input, output_tokens: output };
}

async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    throw providerError('invalid_output', 'the answer is larger than the limit');
  }
  if (res.body === null) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw providerError('invalid_output', 'the answer is larger than the limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
