import { duration, easingCurve } from '@qiu-creator/design-tokens';
import { currentMotionMode, moves } from './motion-mode.js';

/**
 * 分段控制、AI 分頁指示器 (DESIGN.md 動效, QC-065 area 5): when the chosen
 * segment or tab changes, its highlight glides from the old one to the new one
 * instead of jumping, so the eye follows where the choice went. One watcher
 * for the whole App covers every `.seg` (aria-pressed) and the AI panel's tab
 * underline (aria-selected), with no change to the controls themselves.
 *
 * How: the new segment's own highlight is hidden for the moment
 * (`data-gliding`), a copy of it travels from the old box to the new one
 * (transform only), then goes. Without full motion nothing glides.
 */

/** Where a highlight glides, and what it looks like. */
interface Group {
  /** The control holding the choices. */
  container: string;
  /** The attribute that marks the chosen one. */
  attr: 'aria-pressed' | 'aria-selected';
  /** A filled pill (segments) or the 2 px underline (tabs). */
  kind: 'pill' | 'underline';
}

const GROUPS: readonly Group[] = [
  { container: '.seg', attr: 'aria-pressed', kind: 'pill' },
  { container: '.ai__tab-list', attr: 'aria-selected', kind: 'underline' },
];

/** The box a highlight travels between, relative to the viewport. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Keyframes taking a highlight drawn at `to` so it starts exactly over `from`. */
export function glideKeyframes(from: Box, to: Box): Keyframe[] {
  const sx = to.width === 0 ? 1 : from.width / to.width;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  return [
    {
      transform: `translate(${String(dx)}px, ${String(dy)}px) scaleX(${String(sx)})`,
    },
    { transform: 'translate(0px, 0px) scaleX(1)' },
  ];
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function glide(group: Group, container: HTMLElement, fromEl: Element, toEl: HTMLElement): void {
  const from = boxOf(fromEl);
  const to = boxOf(toEl);
  if (to.width === 0 || from.width === 0) return;
  const look = getComputedStyle(toEl);
  const origin = container.getBoundingClientRect();
  // Inside the control, under its buttons, so the labels stay on top.
  const pill = document.createElement('span');
  pill.setAttribute('aria-hidden', 'true');
  pill.className = 'seg-glide';
  const underline = group.kind === 'underline';
  Object.assign(pill.style, {
    position: 'absolute',
    left: `${String(to.left - origin.left)}px`,
    top: `${String((underline ? to.top + to.height - 2 : to.top) - origin.top)}px`,
    width: `${String(to.width)}px`,
    height: underline ? '2px' : `${String(to.height)}px`,
    borderRadius: underline ? '1px' : look.borderRadius,
    background: underline ? look.borderBottomColor : look.backgroundColor,
    boxShadow: underline ? 'none' : look.boxShadow,
    transformOrigin: 'left center',
    pointerEvents: 'none',
    zIndex: '0',
  });
  toEl.dataset['gliding'] = 'true';
  container.append(pill);
  const run = pill.animate(glideKeyframes(from, to), {
    duration: duration.base,
    easing: `cubic-bezier(${easingCurve.out.join(', ')})`,
  });
  const done = () => {
    pill.remove();
    delete toEl.dataset['gliding'];
  };
  run.onfinish = done;
  run.oncancel = done;
}

/** Watch the App for choice changes and glide their highlights; returns the way to stop. */
export function installSegmentGlide(root: Node = document.body): () => void {
  const observer = new MutationObserver((records) => {
    if (!moves(currentMotionMode())) return;
    for (const group of GROUPS) {
      const changed = records.filter(
        (r) =>
          r.attributeName === group.attr &&
          r.target instanceof HTMLElement &&
          r.target.closest(group.container) !== null,
      );
      for (const rec of changed) {
        const target = rec.target as HTMLElement;
        if (target.getAttribute(group.attr) !== 'true') continue;
        const container = target.closest<HTMLElement>(group.container);
        if (container === null) continue;
        // The one that was chosen a moment ago, in the same control.
        const before = changed.find(
          (r) =>
            r.target !== target &&
            r.oldValue === 'true' &&
            (r.target as HTMLElement).closest(group.container) === container,
        );
        if (before !== undefined) glide(group, container, before.target as Element, target);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: GROUPS.map((g) => g.attr),
  });
  return () => {
    observer.disconnect();
  };
}
