/**
 * Selection in 作品庫 (QC-052), as in Finder: a plain click selects one, ⌘
 * adds or removes one, ⇧ selects the range from the anchor (the last plain or
 * ⌘ click), ⌘A selects everything shown. Pure, so the rules are unit tested.
 */
export interface Selection {
  readonly ids: ReadonlySet<string>;
  /** Where a ⇧ range starts; null before the first click. */
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

export interface ClickModifiers {
  meta: boolean;
  shift: boolean;
}

/** The selection after clicking `id` among `order` (the works shown, in order). */
export function clickSelect(
  sel: Selection,
  id: string,
  order: readonly string[],
  mods: ClickModifiers,
): Selection {
  if (mods.shift && sel.anchor !== null && order.includes(sel.anchor)) {
    const a = order.indexOf(sel.anchor);
    const b = order.indexOf(id);
    if (b < 0) return sel;
    const [from, to] = a <= b ? [a, b] : [b, a];
    const range = order.slice(from, to + 1);
    // ⌘⇧ adds the range to what is selected; ⇧ alone replaces it.
    const ids = new Set(mods.meta ? [...sel.ids, ...range] : range);
    return { ids, anchor: sel.anchor };
  }
  if (mods.meta || mods.shift) {
    const ids = new Set(sel.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { ids, anchor: id };
  }
  return { ids: new Set([id]), anchor: id };
}

export function selectAll(order: readonly string[]): Selection {
  return { ids: new Set(order), anchor: order[0] ?? null };
}

/** Drop ids that are no longer shown (filtered out, deleted elsewhere). */
export function keepShown(sel: Selection, order: readonly string[]): Selection {
  const shown = new Set(order);
  if ([...sel.ids].every((id) => shown.has(id)) && (sel.anchor === null || shown.has(sel.anchor)))
    return sel;
  return {
    ids: new Set([...sel.ids].filter((id) => shown.has(id))),
    anchor: sel.anchor !== null && shown.has(sel.anchor) ? sel.anchor : null,
  };
}

/**
 * Right-click: on a work that is part of the selection the menu acts on the
 * whole selection (in the order shown); on any other work, on that work alone,
 * and the selection stays as it was.
 */
export function contextTargets(sel: Selection, id: string, order: readonly string[]): string[] {
  return sel.ids.has(id) ? order.filter((o) => sel.ids.has(o)) : [id];
}

/** What a key in the rename field does. Enter while the IME is composing picks the candidate. */
export function renameKey(e: { key: string; isComposing: boolean }): 'commit' | 'cancel' | null {
  // Chromium reports keys the IME consumes as `Process`.
  if (e.isComposing || e.key === 'Process') return null;
  if (e.key === 'Enter') return 'commit';
  if (e.key === 'Escape') return 'cancel';
  return null;
}

/** The title to save, or null when nothing should be sent (blank or unchanged). */
export function renameTitle(before: string, typed: string): string | null {
  const title = typed.trim();
  if (title === '' || title === before) return null;
  return title.slice(0, 500);
}
