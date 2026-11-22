import { ApiError } from '@qiu-creator/api-client';
import type { AiRelayModel } from '@qiu-creator/contracts';
import { errorText, t } from './i18n.js';

/**
 * Rules for the New API model picker (QC-054), kept apart from React so they
 * are unit tested: which models to list, and how a failed list is explained.
 */

/**
 * The models to offer for `query`. By default only chat models; the model in
 * use always stays listed (custom relay names are `unknown` and would
 * otherwise vanish behind 只列對話).
 */
export function visibleModels(
  models: readonly AiRelayModel[],
  options: { query: string; showAll: boolean; current: string },
): AiRelayModel[] {
  const q = options.query.trim().toLowerCase();
  return models.filter(
    (m) =>
      (options.showAll || m.kind === 'chat' || m.id === options.current) &&
      (q === '' || m.id.toLowerCase().includes(q)),
  );
}

/** The listed model with this id, or null when the relay does not offer it. */
export function findModel(models: readonly AiRelayModel[], id: string): AiRelayModel | null {
  return models.find((m) => m.id === id.trim()) ?? null;
}

export interface ModelListProblem {
  message: string;
  /** For TechnicalDetails: the code and its details, never the key. */
  technical: string | null;
}

function detailsOf(err: ApiError): Record<string, unknown> {
  return err.body?.error.details ?? {};
}

const UNREACHABLE = {
  timeout: 'modelPicker.unreachableTimeout',
  dns: 'modelPicker.unreachableDns',
  tls: 'modelPicker.unreachableTls',
  connection: 'modelPicker.unreachableConnection',
  unavailable: 'modelPicker.unreachableUnavailable',
  quota: 'modelPicker.unreachableQuota',
} as const;

const BAD_RESPONSE = {
  not_json: 'modelPicker.badNotJson',
  missing_data: 'modelPicker.badMissingData',
  too_large: 'modelPicker.badTooLarge',
  unexpected_status: 'modelPicker.badStatus',
  redirect: 'modelPicker.badRedirect',
} as const;

function pick<K extends string, V>(table: Readonly<Record<K, V>>, key: unknown): V | null {
  return typeof key === 'string' && key in table ? table[key as K] : null;
}

/** Why the model list could not be fetched, in the interface language. */
export function describeModelListError(err: unknown): ModelListProblem {
  if (!(err instanceof ApiError)) return { message: errorText(err), technical: null };
  const d = detailsOf(err);
  const status = typeof d['status'] === 'number' ? String(d['status']) : '—';
  const technical = [
    err.code ?? `HTTP ${String(err.status)}`,
    ...Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`),
  ].join(' · ');
  let message: string;
  switch (err.code) {
    case 'ai_key_missing':
      message = t('modelPicker.keyMissing');
      break;
    case 'ai_key_invalid':
      message = t('modelPicker.keyInvalid', { status });
      break;
    case 'ai_gateway_unreachable': {
      const key = pick(UNREACHABLE, d['reason']);
      message = key === null ? errorText(err) : t(key, { status });
      break;
    }
    case 'ai_gateway_bad_response': {
      const key = pick(BAD_RESPONSE, d['reason']);
      message = key === null ? errorText(err) : t(key, { status });
      break;
    }
    default:
      message = errorText(err);
  }
  return { message, technical };
}
