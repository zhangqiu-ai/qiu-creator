import {
  createPartFromUri,
  GoogleGenAI,
  MediaResolution,
  type GenerateContentResponse,
} from '@google/genai';
import {
  codeForStatus,
  isAbort,
  providerError,
  type AiTextRequest,
  type AiTextResult,
} from '../provider.js';
import type { AdapterOptions } from './anthropic.js';
import { classify, toTextResult } from './gemini.js';

const DEFAULT_ORIGIN = 'https://generativelanguage.googleapis.com';

/** A file in the Gemini Files API. */
export interface GeminiRemoteFile {
  name: string;
  uri: string | null;
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED' | 'STATE_UNSPECIFIED';
  error: string | null;
  /** When Google deletes the file (ISO time), if it said; uploads expire after 48 hours. */
  expiration_time: string | null;
  /** When the file was created (ISO time), if it said. */
  create_time: string | null;
}

export type UploadChunkResult = { status: 'active' } | { status: 'final'; file: GeminiRemoteFile };

/**
 * Gemini Files API and video prompts (QC-023).
 *
 * Uploads use Google's resumable upload protocol directly (start → chunks of
 * 8 MiB with `X-Goog-Upload-Offset` → `upload, finalize`), as the Gemini
 * Files API docs describe, because `@google/genai`'s `files.upload` reports
 * no progress and cannot resume after a dropped connection. Resuming asks the
 * server how much it has with the protocol's `query` command; the Gemini docs
 * do not list that command, so callers fall back to a fresh upload when it is
 * not answered. Everything else (`files.get`, `files.delete`,
 * `generateContent`) goes through the SDK. The upload path follows the SDK's
 * default API version (`/upload/v1/files`).
 */
export class GeminiVideoClient {
  constructor(private readonly options: AdapterOptions) {}

  private origin(): string {
    return (this.options.baseUrl ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
  }

  private sdk(apiKey: string): GoogleGenAI {
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl }),
        timeout: this.options.timeoutMs,
        retryOptions: { attempts: 1 },
      },
    });
  }

  /** Begin a resumable upload; returns the session's upload URL. */
  async startUpload(
    file: { sizeBytes: number; mimeType: string; displayName: string },
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string> {
    const res = await this.send(
      `${this.origin()}/upload/v1/files`,
      {
        'x-goog-api-key': apiKey,
        'content-type': 'application/json',
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': String(file.sizeBytes),
        'x-goog-upload-header-content-type': file.mimeType,
      },
      JSON.stringify({ file: { display_name: file.displayName } }),
      signal,
    );
    const url = res.headers.get('x-goog-upload-url');
    if (url === null) throw providerError('provider_unavailable', 'no upload URL returned');
    return url;
  }

  /** Bytes the server has for an upload session, or null if it cannot say (start over). */
  async queryUpload(
    uploadUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<number | null> {
    try {
      const res = await this.send(
        uploadUrl,
        { 'x-goog-api-key': apiKey, 'x-goog-upload-command': 'query' },
        undefined,
        signal,
      );
      if (res.headers.get('x-goog-upload-status') !== 'active') return null;
      const received = Number(res.headers.get('x-goog-upload-size-received'));
      return Number.isInteger(received) && received >= 0 ? received : null;
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      return null;
    }
  }

  async uploadChunk(
    uploadUrl: string,
    offset: number,
    data: Buffer,
    final: boolean,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<UploadChunkResult> {
    const res = await this.send(
      uploadUrl,
      {
        'x-goog-api-key': apiKey,
        'content-length': String(data.length),
        'x-goog-upload-offset': String(offset),
        'x-goog-upload-command': final ? 'upload, finalize' : 'upload',
      },
      data,
      signal,
    );
    const status = res.headers.get('x-goog-upload-status');
    if (status === 'final') {
      const body = (await res.json()) as { file?: unknown };
      return { status: 'final', file: toRemoteFile(body.file) };
    }
    if (status === 'active') return { status: 'active' };
    throw providerError('provider_unavailable', `unexpected upload status ${String(status)}`);
  }

  async getFile(name: string, apiKey: string, signal: AbortSignal): Promise<GeminiRemoteFile> {
    try {
      return toRemoteFile(
        await this.sdk(apiKey).files.get({ name, config: { abortSignal: signal } }),
      );
    } catch (err) {
      throw classify(err, signal);
    }
  }

  /** Best effort: Google also deletes uploads after 48 hours. */
  async deleteFile(name: string, apiKey: string): Promise<boolean> {
    try {
      await this.sdk(apiKey).files.delete({
        name,
        config: { abortSignal: AbortSignal.timeout(10_000) },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** `generateContent` with the uploaded video as a file part before the prompt. */
  async generate(
    req: AiTextRequest & { fileUri: string; mimeType: string; lowResolution: boolean },
    apiKey: string,
  ): Promise<AiTextResult> {
    let response: GenerateContentResponse;
    try {
      response = await this.sdk(apiKey).models.generateContent({
        model: req.model,
        contents: [
          {
            role: 'user',
            parts: [createPartFromUri(req.fileUri, req.mimeType), { text: req.prompt }],
          },
        ],
        config: {
          maxOutputTokens: req.maxOutputTokens,
          abortSignal: req.signal,
          ...(req.system === undefined ? {} : { systemInstruction: req.system }),
          ...(req.jsonSchema === undefined
            ? {}
            : { responseMimeType: 'application/json', responseJsonSchema: req.jsonSchema }),
          ...(req.lowResolution ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW } : {}),
        },
      });
    } catch (err) {
      throw classify(err, req.signal);
    }
    return toTextResult(response, req.model);
  }

  /** fetch with our abort signal plus a per-request timeout, mapped to ProviderErrors. */
  private async send(
    url: string,
    headers: Record<string, string>,
    body: string | Buffer | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : new Uint8Array(body) }),
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      if (timeout.aborted) throw providerError('timeout');
      throw providerError('provider_unavailable');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = codeForStatus(res.status);
      const invalidKey = res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(text);
      throw providerError(invalidKey ? 'invalid_key' : code, undefined, res.status);
    }
    return res;
  }
}

function toRemoteFile(raw: unknown): GeminiRemoteFile {
  const f = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    name?: unknown;
    uri?: unknown;
    state?: unknown;
    error?: { message?: unknown } | null;
    expirationTime?: unknown;
    createTime?: unknown;
  };
  if (typeof f.name !== 'string') throw providerError('provider_unavailable', 'file has no name');
  const state =
    f.state === 'PROCESSING' || f.state === 'ACTIVE' || f.state === 'FAILED'
      ? f.state
      : 'STATE_UNSPECIFIED';
  return {
    name: f.name,
    uri: typeof f.uri === 'string' ? f.uri : null,
    state,
    error: typeof f.error?.message === 'string' ? f.error.message : null,
    expiration_time: typeof f.expirationTime === 'string' ? f.expirationTime : null,
    create_time: typeof f.createTime === 'string' ? f.createTime : null,
  };
}
