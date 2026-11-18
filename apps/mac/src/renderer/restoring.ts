import { ApiError } from '@qiu-creator/api-client';

/**
 * 503 `restoring` (QC-030): a backup restore was accepted and the service is
 * about to reload, so every write is refused for a moment. Not a failure of
 * the page that asked: it says so and the app shows 「還原中」 until the
 * service is back (QC-031).
 */
export const RESTORING_TEXT = '服務正在還原資料庫，請稍候再試';

export function isRestoring(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503 && err.code === 'restoring';
}

/** The usual 「server message, or 無法連線到服務」 text, with 503 `restoring` in the user's words. */
export function serviceErrorText(err: unknown): string {
  if (isRestoring(err)) return RESTORING_TEXT;
  return err instanceof ApiError ? err.message : '無法連線到服務';
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
