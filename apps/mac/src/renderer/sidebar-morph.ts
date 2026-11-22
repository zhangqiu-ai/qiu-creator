import { duration, easing } from '@qiu-creator/design-tokens';
import { currentMotionMode, moves } from './motion-mode.js';
import { LEAVING } from './motion.js';

/**
 * 側欄收合／展開的過渡 (DESIGN.md 動效 · 側欄收合, QC-068). The sidebar takes its
 * new width at once (so nothing is re-laid out frame by frame) and the change
 * is drawn with transform and opacity only:
 *
 * - collapsing: a still copy of the full sidebar slides left over the new icon
 *   rail and fades, its right edge travelling with the content's left edge
 *   (the content slides from its old place, same `moderate` / `inOut`);
 * - expanding: the full sidebar slides in from the left behind the copy of the
 *   rail, which fades, and its contents fade in (`fast`);
 * - with reduced motion (or a hot Mac) only the copy fades, in `fast`; with
 *   motion off (e2e) nothing animates.
 *
 * The copy is inert and hidden from assistive technology, so focus and the
 * accessibility tree only ever see the real sidebar.
 */

export interface SidebarSnapshot {
  ghost: HTMLElement;
  rect: DOMRect;
}

let running: { ghost: HTMLElement; animations: Animation[] } | null = null;

/**
 * Stop a transition still on screen; the sidebar is already in its final place.
 * Also called when the sidebar changes without its toggle (a narrow window
 * forces the rail, QC-073): a transition worked out for the old widths would
 * otherwise go on moving the sidebar off its new place.
 */
export function stopSidebarMorph(): void {
  stopRunning();
}

function stopRunning(): void {
  if (running === null) return;
  for (const a of running.animations) a.cancel();
  running.ghost.remove();
  running = null;
}

/** Copy the sidebar as it looks now, before it changes. Null when nothing will animate. */
export function snapshotSidebar(nav: HTMLElement | null): SidebarSnapshot | null {
  if (nav === null || currentMotionMode() === 'off') return null;
  stopRunning();
  const rect = nav.getBoundingClientRect();
  const ghost = nav.cloneNode(true) as HTMLElement;
  // The copy is only a picture: no ids to collide, nothing to focus or announce.
  for (const el of [ghost, ...ghost.querySelectorAll<HTMLElement>('[id]')])
    el.removeAttribute('id');
  ghost.removeAttribute('aria-label');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.classList.add('sb--ghost');
  ghost.setAttribute(LEAVING, '');
  Object.assign(ghost.style, {
    position: 'fixed',
    top: `${String(rect.top)}px`,
    left: `${String(rect.left)}px`,
    width: `${String(rect.width)}px`,
    height: `${String(rect.height)}px`,
    flexBasis: 'auto',
  });
  return { ghost, rect };
}

/** Animate from the snapshot to the sidebar as it is now (call after the change is in the DOM). */
export function morphSidebar(nav: HTMLElement | null, snap: SidebarSnapshot | null): void {
  if (nav === null || snap === null) return;
  const { ghost, rect } = snap;
  const mode = currentMotionMode();
  if (mode === 'off') return;
  nav.after(ghost);
  const now = nav.getBoundingClientRect();
  const shift = rect.width - now.width; // > 0 collapsing, < 0 expanding
  const moderate = { duration: duration.moderate, easing: easing.inOut };
  const fast = { duration: duration.fast, easing: easing.out };
  const animations: Animation[] = [];
  // The content beside it starts where it was and slides to its new place.
  const main = nav.parentElement?.querySelector<HTMLElement>(':scope > .shell__main') ?? null;
  if (main !== null && moves(mode) && shift !== 0)
    animations.push(
      main.animate(
        [{ transform: `translateX(${String(shift)}px)` }, { transform: 'translateX(0)' }],
        moderate,
      ),
    );
  // The copy fades for good: it stays hidden until it is removed.
  const fadeOut = { ...fast, fill: 'forwards' } as const;
  if (!moves(mode) || shift === 0) {
    animations.push(ghost.animate([{ opacity: 1 }, { opacity: 0 }], fadeOut));
  } else if (shift > 0) {
    // Collapsing: the labels fade at once, the panel slides away and, in its
    // second half, lets the rail beneath show through.
    for (const part of ghost.children)
      animations.push(part.animate([{ opacity: 1 }, { opacity: 0 }], fadeOut));
    animations.push(
      ghost.animate(
        [
          { transform: 'translateX(0)', opacity: 1 },
          { opacity: 1, offset: 0.4 },
          { transform: `translateX(${String(-shift)}px)`, opacity: 0 },
        ],
        { ...moderate, fill: 'forwards' },
      ),
    );
  } else {
    // Expanding: the panel slides in with its contents fading in, over the
    // rail, which fades away.
    animations.push(
      nav.animate(
        [{ transform: `translateX(${String(shift)}px)` }, { transform: 'translateX(0)' }],
        moderate,
      ),
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], fadeOut),
    );
    for (const part of nav.children)
      animations.push(
        part.animate([{ opacity: 0 }, { opacity: 1 }], { ...moderate, easing: easing.out }),
      );
  }
  const current = { ghost, animations };
  running = current;
  void Promise.all(animations.map((a) => a.finished)).then(
    () => {
      if (running === current) stopRunning();
    },
    () => undefined,
  );
}
