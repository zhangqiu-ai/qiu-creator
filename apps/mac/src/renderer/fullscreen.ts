/**
 * Esc leaves HTML fullscreen (QC-104). Electron exits a video's fullscreen on
 * Esc itself when the key reaches it first; when the page gets the key instead
 * (keys sent by the window, as in e2e), this does the same, and stops the key
 * there so it does not also close the 大圖預覽 or a dialog underneath. Leaving
 * hands focus back to the player's container, so the next Esc reaches the
 * 大圖預覽 it sits in instead of the page body.
 */
export interface FullscreenDocument {
  readonly fullscreenElement: Element | null;
  exitFullscreen(): Promise<void>;
}

type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'defaultPrevented' | 'preventDefault' | 'stopImmediatePropagation'
>;

/**
 * Leaves fullscreen on Esc. Returns the element that was fullscreen and a
 * promise for the exit, or null when the key is not for this.
 */
export function exitFullscreenOnEscape(
  event: KeyLike,
  doc: FullscreenDocument,
): { element: Element; exited: Promise<void> } | null {
  const element = doc.fullscreenElement;
  if (event.key !== 'Escape' || event.defaultPrevented || element === null) return null;
  event.preventDefault();
  event.stopImmediatePropagation();
  return { element, exited: doc.exitFullscreen() };
}

/**
 * The element to focus after fullscreen: the focusable container of the one
 * that was fullscreen (the 大圖預覽 dialog, the editor's player), else that
 * element. A focused `<video>` itself does not get keys after fullscreen.
 * Nothing when it left the page.
 */
export function focusAfterFullscreen(wasFullscreen: Element): HTMLElement | null {
  if (!(wasFullscreen instanceof HTMLElement) || !wasFullscreen.isConnected) return null;
  const container = wasFullscreen.parentElement?.closest('[tabindex]');
  return container instanceof HTMLElement ? container : wasFullscreen;
}

/** Listens before every other key handler (capture on the window). */
export function installFullscreenEscape(target: Window = window): void {
  target.addEventListener(
    'keydown',
    (event) => {
      const left = exitFullscreenOnEscape(event, target.document);
      if (left === null) return;
      left.exited
        .then(() => {
          // Chromium settles focus after the exit; focus on the next task.
          target.setTimeout(
            () => focusAfterFullscreen(left.element)?.focus({ preventScroll: true }),
            0,
          );
        })
        .catch(() => undefined);
    },
    { capture: true },
  );
}
