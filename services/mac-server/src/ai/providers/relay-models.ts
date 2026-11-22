import {
  AI_MODELS_MAX_BYTES,
  type AiGatewayBadResponseReason,
  type AiGatewayUnreachableReason,
} from '@qiu-creator/contracts';
import { ServiceError } from '../../errors.js';
import { sanitizeDetail } from '../provider.js';

/** Where and how to list models for one provider (QC-054, QC-057). */
export interface ModelListRequest {
  url: string;
  /** Carries the key; sent only to `url`, never logged or echoed. */
  headers: Record<string, string>;
  timeoutMs: number;
  /** `data` (OpenAI, Anthropic, New API) or `models` (Gemini). */
  listKey: 'data' | 'models';
  /** `id` or `name` (Gemini: `models/<id>`; the `models/` prefix is dropped). */
  idKey: 'id' | 'name';
}

/**
 * List the models a key can use: one GET that sends no content and costs
 * nothing (QC-054 New API, QC-057 connection test for every provider).
 *
 * - The key goes only in `headers`, only to `url`: redirects are not
 *   followed, and no error carries the key, the URL or the response body.
 * - At most `AI_MODELS_MAX_BYTES` are read.
 * - Failures are `ServiceError`s with 502 `ai_key_invalid`,
 *   `ai_gateway_unreachable` or `ai_gateway_bad_response` and a `details.reason`.
 *
 * Returns the model ids, deduplicated and sorted.
 */
export async function fetchModelList(req: ModelListRequest): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: 'GET',
      headers: { ...req.headers, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    throw unreachable(networkReason(err), networkDetail(err));
  }
  if (res.status === 401 || res.status === 403) {
    await discard(res);
    throw new ServiceError(502, 'ai_key_invalid', 'the provider refused the API key', {
      status: res.status,
    });
  }
  if (res.status === 402 || res.status === 429) {
    // Quota (billing or credit used up) or a plain rate limit, from the error
    // body (`classifyTooManyRequests`). Only the verdict is kept; the body
    // itself goes nowhere.
    const reason = res.status === 402 ? 'quota' : classifyTooManyRequests(await bodyText(res));
    throw unreachable(reason, undefined, res.status);
  }
  if (res.status >= 500) {
    await discard(res);
    throw unreachable('unavailable', undefined, res.status);
  }
  if (res.status >= 300 && res.status < 400) {
    await discard(res);
    throw badResponse('redirect', res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    await discard(res);
    throw badResponse('unexpected_status', res.status);
  }

  let text: string;
  try {
    text = await readLimited(res, AI_MODELS_MAX_BYTES);
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw unreachable(networkReason(err), networkDetail(err));
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw badResponse('not_json');
  }
  const data: unknown =
    body !== null && typeof body === 'object' && req.listKey in body
      ? (body as Record<string, unknown>)[req.listKey]
      : undefined;
  // Gemini omits `models` entirely when the key can use none.
  if (data === undefined && req.listKey === 'models' && body !== null && typeof body === 'object') {
    return [];
  }
  if (!Array.isArray(data)) throw badResponse('missing_data');
  const list: unknown[] = data;
  const ids = new Set<string>();
  for (const item of list) {
    const raw: unknown =
      item !== null && typeof item === 'object' && req.idKey in item
        ? (item as Record<string, unknown>)[req.idKey]
        : undefined;
    if (typeof raw !== 'string') continue;
    const id = (req.idKey === 'name' ? raw.replace(/^models\//, '') : raw).trim();
    if (id !== '' && id.length <= 200) ids.add(id);
  }
  if (list.length > 0 && ids.size === 0) throw badResponse('missing_data');
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `GET {baseUrl}/models` on an OpenAI-compatible relay (New API, QC-054). */
export function fetchRelayModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<string[]> {
  return fetchModelList({
    url: `${baseUrl.replace(/\/+$/, '')}/models`,
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs,
    listKey: 'data',
    idKey: 'id',
  });
}

async function bodyText(res: Response): Promise<string> {
  try {
    return await readLimited(res, 64 * 1024);
  } catch {
    return '';
  }
}

/** OpenAI-style error codes that mean the account has no credit or quota left. */
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'billing_not_active',
  'insufficient_balance',
  'insufficient_user_quota',
]);
const RATE_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error', 'requests', 'tokens']);

/** Plain-text signs of used-up credit or balance (New API relays, Chinese messages). */
const QUOTA_TEXT =
  /insufficient[_ ]quota|insufficient[_ ](balance|funds|credits?)|credit balance is too low|credits? (are |is )?(depleted|exhausted)|prepayment credits|billing hard limit|余额不足|餘額不足|额度不足|額度不足|额度已用尽|額度已用盡/i;

/**
 * A 429 is `quota` only when the provider says plainly that billing or credit
 * is used up; anything else, including anything unclear, is `rate_limited`
 * (「暫時受限，稍後重試」), the safer thing to tell the user (QC-057).
 *
 * - Gemini (`RESOURCE_EXHAUSTED`): only the structured details count, never
 *   generic message text, because Gemini says "check your plan and billing
 *   details" for per-minute limits too; only explicit used-up-credit wording counts. `QuotaFailure` violations on request
 *   or token limits per minute, hour or day are rate limits; an `ErrorInfo`
 *   reason or a violation about billing, credit or prepayment is quota.
 * - OpenAI-compatible (GPT, New API): `error.code`/`error.type` first
 *   (`insufficient_quota` → quota, `rate_limit_exceeded` → rate limited),
 *   then explicit used-up-credit wording.
 */
export function classifyTooManyRequests(text: string): 'quota' | 'rate_limited' {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return QUOTA_TEXT.test(text) ? 'quota' : 'rate_limited';
  }
  const error = field(body, 'error');
  if (field(error, 'status') === 'RESOURCE_EXHAUSTED') {
    if (geminiKind(field(error, 'details')) === 'quota') return 'quota';
    // Only unambiguous wording ("prepayment credits are depleted"); the usual
    // "check your plan and billing details" of a rate limit does not match.
    const message = field(error, 'message');
    return typeof message === 'string' && QUOTA_TEXT.test(message) ? 'quota' : 'rate_limited';
  }
  for (const key of ['code', 'type']) {
    const value = field(error, key);
    if (typeof value !== 'string') continue;
    if (QUOTA_CODES.has(value.toLowerCase())) return 'quota';
    if (RATE_CODES.has(value.toLowerCase())) return 'rate_limited';
  }
  const message = field(error, 'message');
  return typeof message === 'string' && QUOTA_TEXT.test(message) ? 'quota' : 'rate_limited';
}

const GEMINI_BILLING = /billing|credit|prepa(y|id)|payment|balance/i;

function geminiKind(details: unknown): 'quota' | 'rate_limited' {
  if (!Array.isArray(details)) return 'rate_limited';
  for (const detail of details as unknown[]) {
    const type = field(detail, '@type');
    if (typeof type !== 'string') continue;
    if (type.endsWith('google.rpc.ErrorInfo')) {
      const reason = field(detail, 'reason');
      if (typeof reason === 'string' && GEMINI_BILLING.test(reason)) return 'quota';
    }
    if (type.endsWith('google.rpc.QuotaFailure')) {
      const violations = field(detail, 'violations');
      if (!Array.isArray(violations)) continue;
      for (const v of violations as unknown[]) {
        const id = [field(v, 'quotaId'), field(v, 'quotaMetric'), field(v, 'subject')]
          .filter((x): x is string => typeof x === 'string')
          .join(' ');
        if (GEMINI_BILLING.test(id)) return 'quota';
      }
    }
  }
  // Per-minute/day request and token limits, and anything unrecognised.
  return 'rate_limited';
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The shorter of the adapter's timeout and a per-call limit (QC-057 test: 10 s). */
export function effectiveTimeout(adapterMs: number, callMs: number | undefined): number {
  return callMs === undefined ? adapterMs : Math.min(adapterMs, callMs);
}

/** Network failure → reason. Exported for tests (DNS and TLS cannot be faked locally). */
export function networkReason(err: unknown): AiGatewayUnreachableReason {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'timeout';
  }
  const code = errorCode(err);
  if (code === undefined) return 'connection';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'dns';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  if (
    /^(CERT_|ERR_TLS|ERR_SSL|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|HOSTNAME_MISMATCH)/.test(code) ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    return 'tls';
  }
  return 'connection';
}

/** The error code of `err` or its `cause` chain (undici wraps socket errors). */
function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function networkDetail(err: unknown): string | undefined {
  const code = errorCode(err);
  return code === undefined ? undefined : sanitizeDetail(code);
}

function unreachable(
  reason: AiGatewayUnreachableReason,
  detail?: string,
  status?: number,
): ServiceError {
  return new ServiceError(502, 'ai_gateway_unreachable', 'the relay could not be reached', {
    reason,
    ...(status === undefined ? {} : { status }),
    ...(detail === undefined ? {} : { detail }),
  });
}

function badResponse(reason: AiGatewayBadResponseReason, status?: number): ServiceError {
  return new ServiceError(
    502,
    'ai_gateway_bad_response',
    'the relay did not answer with a model list',
    { reason, ...(status === undefined ? {} : { status }) },
  );
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(res);
    throw badResponse('too_large');
  }
  if (res.body === null) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw badResponse('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to do: the body is not needed.
  }
}
