import type { AiFailureCode, AiProvider, AiUsage } from '@qiu-creator/contracts';

/** One text generation request, provider-neutral. */
export interface AiTextRequest {
  model: string;
  system?: string | undefined;
  prompt: string;
  /** JSON Schema: ask for structured output (the adapter uses the provider's native mode). */
  jsonSchema?: Record<string, unknown> | undefined;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface AiTextResult {
  text: string;
  usage: AiUsage;
  /** Model that actually served the request (may differ, e.g. after a refusal fallback). */
  model: string;
  /** `max_tokens`: the output was cut off at `maxOutputTokens`. */
  finish: 'stop' | 'max_tokens';
  /**
   * Cost worked out by the task itself (QC-070: images × `per_image_usd`);
   * when absent, the cost comes from `usage` and the token price.
   */
  costUsd?: number | null;
}

/** A file handed to a provider for later prompts (Gemini video, QC-023). */
export interface AiFileUpload {
  path: string;
  mimeType: string;
  displayName: string;
  signal: AbortSignal;
}

export interface AiUploadedFile {
  uri: string;
  mimeType: string;
}

/**
 * A cloud (or, later, local) AI provider. Adapters own every HTTP call and
 * translate failures into `ProviderError`; nothing else talks to providers.
 * The API key is passed per call and never kept by the adapter.
 */
export interface AIProvider {
  readonly id: AiProvider;
  generateText(request: AiTextRequest, apiKey: string, baseUrl?: string): Promise<AiTextResult>;
  /** File upload for multimodal prompts. Only Gemini needs it (QC-023 implements it). */
  uploadFile?(file: AiFileUpload, apiKey: string): Promise<AiUploadedFile>;
  /**
   * Model ids the key can use: a free GET that sends no content (QC-054 New
   * API list, QC-057 connection test). See `fetchModelList`. `baseUrl` is the
   * stored New API Base URL; the other providers ignore it.
   */
  listModels?(apiKey: string, baseUrl?: string, timeoutMs?: number): Promise<string[]>;
}

const RETRYABLE: ReadonlySet<AiFailureCode> = new Set([
  'rate_limited',
  'timeout',
  'provider_unavailable',
]);

/** A classified provider failure. `message` must never contain request content or keys. */
export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: AiFailureCode,
    message: string,
    readonly status?: number,
    /** Untranslated technical detail (HTTP status, provider text), sanitized; null if none (QC-043). */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(code);
  }
}

/** Map an HTTP status from a provider to a failure code. */
export function codeForStatus(status: number): AiFailureCode {
  if (status === 401 || status === 403) return 'invalid_key';
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'provider_unavailable';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

const READABLE: Readonly<Record<AiFailureCode, string>> = {
  rate_limited: '供應商限流（429），稍後會自動重試',
  invalid_key: 'API 金鑰無效、已撤銷或沒有權限',
  missing_key: '尚未設定 API 金鑰',
  consent_required: '尚未確認這個供應商的使用告知',
  timeout: '請求逾時',
  content_blocked: '供應商拒絕或以安全理由攔截了這次內容',
  provider_unavailable: '供應商暫時無法使用',
  bad_request: '供應商拒絕了請求（模型名稱或參數有誤）',
  invalid_output: '供應商回傳的結構化結果無法解析',
  file_processing_failed: '供應商無法處理上傳的視頻檔',
  source_unavailable: '素材檔案不存在或無法讀取',
  credential_changed: '中轉站設定已變更，請手動重試',
  unknown: '未知錯誤',
};

/**
 * Build a ProviderError whose message is a fixed readable phrase plus a
 * short, sanitized provider detail. The detail is cut to 200 characters and
 * scrubbed of anything that looks like a key or bearer token.
 */
export function providerError(
  code: AiFailureCode,
  detail?: string,
  status?: number,
): ProviderError {
  const base = READABLE[code];
  const clean = detail === undefined ? '' : sanitizeDetail(detail);
  const statusPart = status === undefined ? '' : ` (HTTP ${String(status)})`;
  const technical = [status === undefined ? '' : `HTTP ${String(status)}`, clean]
    .filter((p) => p !== '')
    .join(': ');
  return new ProviderError(
    code,
    clean === '' ? `${base}${statusPart}` : `${base}${statusPart}：${clean}`,
    status,
    technical === '' ? null : technical,
  );
}

export function sanitizeDetail(detail: string): string {
  return detail
    .replace(
      /(sk-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{10,}|Bearer\s+\S+|x-api-key\S*|key=\S+)/gi,
      '[REDACTED]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** True when an error is an abort raised by our own AbortController. */
export function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted && err instanceof Error && /abort/i.test(`${err.name} ${err.message}`);
}
