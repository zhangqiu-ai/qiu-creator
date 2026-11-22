/**
 * AI provider status changes (QC-055). A key, the consent or a model changes
 * in 設定 while a video panel is already open (tabs are restored and kept
 * alive), so panels read the status again when told: by the settings store,
 * when the window comes back to the foreground, or when the panel is shown.
 */
const listeners = new Set<() => void>();

/** Called by whoever changed a key, consent or model. */
export function notifyAiStatusChanged(): void {
  for (const l of [...listeners]) l();
}

/** Run `refresh` whenever the status may have changed. Returns the unsubscribe. */
export function watchAiStatus(refresh: () => void): () => void {
  listeners.add(refresh);
  const onVisible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  const inWindow = typeof window !== 'undefined';
  if (inWindow) {
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(refresh);
    if (inWindow) {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}
