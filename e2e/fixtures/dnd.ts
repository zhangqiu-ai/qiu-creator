import { expect, type Page } from '@playwright/test';

/**
 * Wait until a dnd-kit drop has fully settled, so the next click lands.
 *
 * After a pointer drag, dnd-kit stops every `click` at the document (capture
 * phase) for a moment, so the drag's own click does nothing; it lifts that
 * guard on a timer. There is no DOM state for it, so this waits on the guard
 * itself: once the floating copy is gone, a probe click is sent to a throwaway
 * element until it arrives. A fixed wait would assume a timing; this observes it.
 */
export async function settleAfterDrop(page: Page): Promise<void> {
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate<boolean>(
        `(() => {
          const probe = document.createElement('span');
          probe.style.position = 'fixed';
          document.body.append(probe);
          let arrived = false;
          probe.addEventListener('click', () => { arrived = true; });
          probe.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          probe.remove();
          return arrived;
        })()`,
      ),
    )
    .toBe(true);
}
