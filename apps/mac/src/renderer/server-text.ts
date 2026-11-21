import type { AiBudgetStatus, AiProviderStatus, BackupFailureReason } from '@qiu-creator/contracts';
import { BackupFailureReasonSchema } from '@qiu-creator/contracts';
import type { MessageKey } from '@qiu-creator/i18n';
import { t } from './i18n.js';

/**
 * Text the service used to write in 繁體中文 (QC-043), built here in the
 * interface language from the codes and numbers it returns. The service's own
 * text fields stay for API clients and are only a fallback for an older
 * service that does not send the codes yet.
 */

/** The first-use notice of a provider, in the interface language. */
export function noticeText(notice: AiProviderStatus['notice']): string {
  if (notice.template === undefined || notice.params === undefined) return notice.text;
  return t(
    notice.template === 'relay' ? 'ai.noticeRelay' : 'ai.noticeCloudProvider',
    notice.params,
  );
}

/** Who receives the content: the company, or "your New API relay" in the interface language. */
export function companyText(provider: AiProviderStatus): string {
  return provider.provider === 'new-api' ? t('ai.relayCompany') : provider.company;
}

/** The over-budget reminder, or null when under budget. */
export function budgetWarningText(budget: AiBudgetStatus): string | null {
  if (!budget.over_budget || budget.budget_usd === null) return null;
  return t('ai.budgetWarning', {
    spent: (budget.projected_usd ?? budget.spent_usd).toFixed(2),
    budget: budget.budget_usd.toFixed(2),
  });
}

const BACKUP_REASON: Readonly<Record<BackupFailureReason, MessageKey>> = {
  disk_full: 'serviceSettings.backupReasonDiskFull',
  permission_denied: 'serviceSettings.backupReasonPermission',
  integrity_failed: 'serviceSettings.backupReasonIntegrity',
  io_error: 'serviceSettings.backupReasonIo',
  unknown: 'serviceSettings.backupReasonUnknown',
};

/** One sentence for a backup failure category; unknown or missing reasons read as "unknown". */
export function backupReasonText(reason: unknown): string {
  const parsed = BackupFailureReasonSchema.safeParse(reason);
  return t(BACKUP_REASON[parsed.success ? parsed.data : 'unknown']);
}

/**
 * Strip anything that looks like a key or token before technical text is
 * shown. The service already does this; the app does it again because the
 * text may come from anywhere (an upstream error body, an errno message).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /(sk-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{10,}|Bearer\s+\S+|x-api-key\S*|(?:api[_-]?key|key|token|secret)=\S+)/gi,
      '[REDACTED]',
    )
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]');
}
