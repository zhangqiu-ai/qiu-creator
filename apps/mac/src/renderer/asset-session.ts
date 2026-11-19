import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { AssetRecord, AssetReferences, MarkdownReferrer } from '@qiu-creator/contracts';
import { assetName } from './format.js';

/**
 * 素材庫 v2 (PT-20261119-001 「v2 · 素材庫：刪除與編輯」, QC-037): names,
 * delete rules, 最近刪除 and the autosaving editor. Framework-free for tests.
 */

/** What the user sees: the display name, else the original file name. */
export function displayName(asset: AssetRecord): string {
  const d = asset.display_name ?? null;
  return d !== null && d.trim() !== '' ? d : assetName(asset);
}

/** `kyoto.jpg` → `.jpg`; no extension → ''. */
export function fileExt(asset: AssetRecord): string {
  const name = asset.original_name ?? asset.path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function isExternal(asset: AssetRecord): boolean {
  return asset.mount_id !== null && asset.mount_id !== undefined;
}

/** Whole days left before 最近刪除 purges it (never below 0). */
export function daysLeft(
  purgeAt: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (purgeAt === null || purgeAt === undefined) return null;
  const ms = Date.parse(purgeAt) - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** Works using an asset, each once, in the order the service lists them. */
export function referencingTitles(refs: AssetReferences): { work_id: string; title: string }[] {
  const seen = new Set<string>();
  const out: { work_id: string; title: string }[] = [];
  for (const r of [...refs.works, ...refs.variants]) {
    if (seen.has(r.work_id)) continue;
    seen.add(r.work_id);
    out.push({ work_id: r.work_id, title: r.title });
  }
  return out;
}

/** The references in a 409 `asset_in_use` answer, or null. */
export function inUseReferences(err: unknown): AssetReferences | null {
  if (!(err instanceof ApiError) || err.code !== 'asset_in_use') return null;
  const refs = err.body?.error.details?.['references'];
  if (typeof refs !== 'object' || refs === null) return null;
  const r = refs as Partial<AssetReferences>;
  return {
    works: Array.isArray(r.works) ? r.works : [],
    variants: Array.isArray(r.variants) ? r.variants : [],
  };
}

/** Error codes of the asset routes, in the user's words. */
export function assetErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return '沒有收到服務的回應';
  switch (err.code) {
    case 'trash_failed':
      return '無法移到系統垃圾桶，原檔未變動';
    case 'asset_file_missing':
      return '原檔不在原來的位置；如果它在系統垃圾桶，請先在 Finder「放回原處」再恢復';
    case 'asset_in_trash':
      return '這個素材已在最近刪除';
    case 'not_found':
      return '找不到這個素材，可能已被刪除';
    case 'restoring':
      return '服務正在還原資料庫，請稍候再試';
    case 'validation_error':
      return '內容格式不正確';
    default:
      return '操作失敗，請稍後再試';
  }
}

/** Works whose Markdown still links to purged files: 「這些作品會出現缺圖」. */
export function brokenLinkTitles(
  purged: readonly { markdown_referrers: MarkdownReferrer[] }[],
): string[] {
  const titles = new Set<string>();
  for (const p of purged) for (const r of p.markdown_referrers) titles.add(r.title);
  return [...titles];
}

/** One tag from the input box (trimmed, ≤64), or null if empty or already there. */
export function normalizeTag(input: string, existing: readonly string[]): string | null {
  const t = input.trim().slice(0, 64);
  if (t === '' || existing.includes(t)) return null;
  return t;
}

export type EditableField = 'display_name' | 'tags' | 'alt_text' | 'note';
export type AssetEdits = Partial<Pick<AssetRecord, EditableField>>;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * After a 409: keep my edits for fields nobody else touched (based on the
 * revision I started from); a field changed both here and elsewhere is a
 * conflict, never overwritten silently.
 */
export function rebaseEdits(
  base: AssetRecord,
  latest: AssetRecord,
  mine: AssetEdits,
): { edits: AssetEdits; conflicts: EditableField[] } {
  const edits: AssetEdits = {};
  const conflicts: EditableField[] = [];
  for (const field of Object.keys(mine) as EditableField[]) {
    const changedElsewhere = !same(base[field], latest[field]);
    const value = mine[field];
    if (changedElsewhere && !same(latest[field], value)) conflicts.push(field);
    else if (!same(latest[field], value)) (edits as Record<string, unknown>)[field] = value;
  }
  return { edits, conflicts };
}

export const FIELD_LABEL: Readonly<Record<EditableField, string>> = {
  display_name: '名稱',
  tags: '標籤',
  alt_text: '替代文字',
  note: '備註',
};

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';

export interface EditorState {
  /** The last version the service confirmed. */
  asset: AssetRecord;
  /** Unsaved edits on top of `asset`. */
  edits: AssetEdits;
  status: SaveStatus;
  error: string | null;
  /** Fields changed here and elsewhere; `theirs` is the service's current version. */
  conflict: { fields: EditableField[]; theirs: AssetRecord } | null;
}

/**
 * Autosave for one asset's 名稱／標籤／替代文字／備註: edits are sent
 * `delayMs` after the last change with `base_revision`; a 409 reloads,
 * rebases and either saves again or asks which version to keep.
 */
export class AssetEditor {
  private state: EditorState;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly client: Pick<CreatorHubClient, 'assets'>,
    asset: AssetRecord,
    private readonly onSaved: (asset: AssetRecord) => void = () => undefined,
    private readonly delayMs = 600,
  ) {
    this.state = { asset, edits: {}, status: 'saved', error: null, conflict: null };
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = (): EditorState => this.state;

  /** The value shown in a field: the unsaved edit, else the saved one. */
  value<F extends EditableField>(field: F): AssetRecord[F] {
    return field in this.state.edits
      ? (this.state.edits[field] as AssetRecord[F])
      : this.state.asset[field];
  }

  private set(patch: Partial<EditorState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** A newer version arrived (SSE or list refresh): take it unless edits are waiting. */
  adopt(asset: AssetRecord): void {
    if (asset.id !== this.state.asset.id) return;
    if ((asset.revision ?? 0) <= (this.state.asset.revision ?? 0)) return;
    if (Object.keys(this.state.edits).length === 0 && this.state.status !== 'conflict') {
      this.set({ asset });
    }
  }

  change<F extends EditableField>(field: F, value: AssetRecord[F]): void {
    if (this.state.status === 'conflict') return;
    const merged: AssetEdits = { ...this.state.edits, [field]: value };
    const edits = same(this.state.asset[field], value) ? omit(merged, [field]) : merged;
    this.set({ edits, status: Object.keys(edits).length === 0 ? 'saved' : 'pending', error: null });
    clearTimeout(this.timer);
    if (Object.keys(edits).length > 0) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.delayMs);
    }
  }

  /** Save now (e.g. on blur, or before switching to another asset). */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving !== null) {
      await this.saving;
    }
    if (Object.keys(this.state.edits).length === 0 || this.state.status === 'conflict') return;
    this.saving = this.save();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }

  private async save(): Promise<void> {
    const base = this.state.asset;
    const sent = this.state.edits;
    this.set({ status: 'saving' });
    try {
      const saved = await this.client.assets.update(base.id, {
        ...sent,
        base_revision: base.revision ?? undefined,
      });
      this.afterSave(saved, sent);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'revision_conflict') {
        await this.rebase(base, sent);
        return;
      }
      this.set({ status: 'error', error: assetErrorText(err) });
    }
  }

  /** Keep edits typed while the request was in flight. */
  private afterSave(saved: AssetRecord, sent: AssetEdits): void {
    const rest: AssetEdits = {};
    for (const [k, v] of Object.entries(this.state.edits) as [EditableField, unknown][]) {
      if (!same(sent[k], v)) (rest as Record<string, unknown>)[k] = v;
    }
    this.set({
      asset: saved,
      edits: rest,
      status: Object.keys(rest).length === 0 ? 'saved' : 'pending',
      error: null,
    });
    this.onSaved(saved);
    if (Object.keys(rest).length > 0) void this.flush();
  }

  private async rebase(base: AssetRecord, sent: AssetEdits): Promise<void> {
    let latest: AssetRecord;
    try {
      latest = await this.client.assets.get(base.id);
    } catch (err) {
      this.set({ status: 'error', error: assetErrorText(err) });
      return;
    }
    const { edits, conflicts } = rebaseEdits(base, latest, { ...sent, ...this.state.edits });
    if (conflicts.length > 0) {
      this.set({
        asset: latest,
        edits: { ...edits, ...pick(this.state.edits, conflicts) },
        status: 'conflict',
        conflict: { fields: conflicts, theirs: latest },
      });
      this.onSaved(latest);
      return;
    }
    this.set({
      asset: latest,
      edits,
      status: Object.keys(edits).length === 0 ? 'saved' : 'pending',
    });
    this.onSaved(latest);
    if (Object.keys(edits).length > 0) await this.save();
  }

  /** 「用我的」 writes my values over the newer ones on purpose; 「用最新的」 drops mine. */
  async resolve(choice: 'mine' | 'theirs'): Promise<void> {
    const c = this.state.conflict;
    if (c === null) return;
    if (choice === 'theirs') {
      const edits = omit(this.state.edits, c.fields);
      this.set({
        conflict: null,
        edits,
        status: Object.keys(edits).length === 0 ? 'saved' : 'pending',
      });
    } else {
      this.set({ conflict: null, status: 'pending' });
    }
    await this.flush();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposed = true;
    this.listeners.clear();
  }
}

function omit(edits: AssetEdits, fields: readonly EditableField[]): AssetEdits {
  return Object.fromEntries(
    Object.entries(edits).filter(([k]) => !fields.includes(k as EditableField)),
  );
}

function pick(edits: AssetEdits, fields: readonly EditableField[]): AssetEdits {
  const out: AssetEdits = {};
  for (const f of fields) if (f in edits) (out as Record<string, unknown>)[f] = edits[f];
  return out;
}
