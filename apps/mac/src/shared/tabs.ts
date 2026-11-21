import type { WorkType } from '@qiu-creator/contracts';

/** Which kind of editor a tab holds; image posts and videos (QC-045/046) plug in here. */
export type TabKind = WorkType;

/** Editor mode kept per tab (the Markdown editor's 視覺／原始碼). */
export type TabMode = 'visual' | 'source';

/**
 * Editor tabs kept in the app preferences between launches (QC-047): order,
 * the active tab, each tab's mode, and its last known title so the tab bar can
 * show before any work is fetched.
 */
export interface PersistedTabs {
  items: { id: string; kind: TabKind; title: string; mode: TabMode | null }[];
  active: string | null;
}

const KINDS: readonly TabKind[] = ['article', 'image', 'video', 'mixed'];

function isTabKind(value: unknown): value is TabKind {
  return KINDS.some((k) => k === value);
}

/** Validate tabs read back from the preferences file (it may be old or hand-edited). */
export function parsePersistedTabs(value: unknown): PersistedTabs | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['items'])) return null;
  const items: PersistedTabs['items'] = [];
  for (const raw of v['items'] as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = r['id'];
    const kind = r['kind'];
    const title = r['title'];
    const mode = r['mode'];
    if (typeof id !== 'string' || id === '' || !isTabKind(kind)) {
      continue;
    }
    items.push({
      id,
      kind,
      title: typeof title === 'string' ? title : '',
      mode: mode === 'visual' || mode === 'source' ? mode : null,
    });
  }
  const active = typeof v['active'] === 'string' ? v['active'] : null;
  return { items, active };
}
