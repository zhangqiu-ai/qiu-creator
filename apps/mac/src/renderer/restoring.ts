import { ApiError } from '@qiu-creator/api-client';
import { codeText, t } from './i18n.js';

/**
 * 503 `restoring` (QC-030): a backup restore was accepted and the service is
 * about to reload, so every write is refused for a moment. Not a failure of
 * the page that asked: it says so and the app shows 「還原中」 until the
 * service is back (QC-031). A function, not a constant, so it follows the
 * interface language (QC-042).
 */
export function restoringText(): string {
  return t('common.restoringText');
}

export function isRestoring(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503 && err.code === 'restoring';
}

/**
 * An error in the user's words: by the service's error code (never its own
 * message, QC-042), 503 `restoring` as 「還原中」, and 無法連線到服務 when
 * the request did not get an answer.
 */
export function serviceErrorText(err: unknown): string {
  if (isRestoring(err)) return restoringText();
  return err instanceof ApiError ? codeText(err.code) : t('common.cannotConnect');
}

const listeners = new Set<() => void>();

/** Called for every 503 `restoring` answer any page gets. */
export function onRestoringSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Inspect a raw response from the service (status and body text). */
export function noteServiceResponse(status: number, body: string | null): void {
  if (status !== 503 || body === null || !body.includes('restoring')) return;
  let code: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error: unknown = parsed.error;
      if (typeof error === 'object' && error !== null && 'code' in error) code = error.code;
    }
  } catch {
    return;
  }
  if (code !== 'restoring') return;
  for (const l of listeners) l();
}
