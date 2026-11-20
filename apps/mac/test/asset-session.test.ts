import { ApiError } from '@qiu-creator/api-client';
import type { AssetRecord } from '@qiu-creator/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetEditor,
  assetErrorText,
  batchInUseReferences,
  deletedToast,
  deleteImpact,
  deleteImpactText,
  brokenLinkTitles,
  daysLeft,
  displayName,
  fileExt,
  inUseReferences,
  isExternal,
  normalizeTag,
  rebaseEdits,
  referencingTitles,
} from '../src/renderer/asset-session.js';

function asset(patch: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'image',
    path: 'library/assets/kyoto.jpg',
    original_name: 'kyoto.jpg',
    mime_type: 'image/jpeg',
    bytes: 1000,
    sha256: 'a'.repeat(64),
    width: 10,
    height: 10,
    duration: null,
    codec: null,
    origin: 'upload',
    created_at: '2026-11-19T00:00:00.000Z',
    thumbnail_status: 'ready',
    metadata_status: 'ready',
    mount_id: null,
    display_name: null,
    tags: [],
    alt_text: null,
    note: null,
    revision: 1,
    deleted_at: null,
    purge_at: null,
    removal: null,
    ...patch,
  } as AssetRecord;
}

function apiError(status: number, code: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(
    status,
    { error: { code, message: code, details } } as unknown as ConstructorParameters<
      typeof ApiError
    >[1],
    code,
  );
}

describe('asset helpers (QC-037)', () => {
  it('names, extensions and where the file lives', () => {
    expect(displayName(asset())).toBe('kyoto.jpg');
    expect(displayName(asset({ display_name: '嵐山竹林' }))).toBe('嵐山竹林');
    expect(displayName(asset({ display_name: '  ' }))).toBe('kyoto.jpg');
    expect(fileExt(asset())).toBe('.jpg');
    expect(fileExt(asset({ original_name: 'README' }))).toBe('');
    expect(isExternal(asset())).toBe(false);
    expect(isExternal(asset({ mount_id: '00000000-0000-4000-8000-000000000009' }))).toBe(true);
  });

  it('counts days left in 最近刪除', () => {
    const now = new Date('2026-11-19T00:00:00Z');
    expect(daysLeft('2026-12-19T00:00:00Z', now)).toBe(30);
    expect(daysLeft('2026-11-19T01:00:00Z', now)).toBe(1);
    expect(daysLeft('2026-11-18T00:00:00Z', now)).toBe(0);
    expect(daysLeft(null, now)).toBeNull();
  });

  it('lists each referencing work once and reads asset_in_use', () => {
    const refs = {
      works: [
        { work_id: 'w1', title: '京都', role: 'cover' as const, position: 0 },
        { work_id: 'w1', title: '京都', role: 'body' as const, position: 1 },
      ],
      variants: [
        { work_id: 'w2', title: '咖啡', platform: 'xiaohongshu' as const, usage: 'image' as const },
      ],
    };
    expect(referencingTitles(refs)).toEqual([
      { work_id: 'w1', title: '京都' },
      { work_id: 'w2', title: '咖啡' },
    ]);
    expect(inUseReferences(apiError(409, 'asset_in_use', { references: refs }))).toEqual(refs);
    expect(inUseReferences(apiError(409, 'asset_in_trash'))).toBeNull();
    expect(inUseReferences(new Error('x'))).toBeNull();
  });

  it('words the asset error codes', () => {
    expect(assetErrorText(apiError(500, 'trash_failed'))).toBe('無法移到系統垃圾桶，原檔未變動');
    expect(assetErrorText(apiError(409, 'asset_file_missing'))).toContain('放回原處');
    expect(assetErrorText(apiError(409, 'asset_in_trash'))).toBe('這個素材已在最近刪除');
    expect(assetErrorText(new TypeError('fetch failed'))).toBe('沒有收到服務的回應');
  });

  it('collects works that will show a missing image after a purge', () => {
    expect(
      brokenLinkTitles([
        { markdown_referrers: [{ work_id: 'w1', title: '京都' }] },
        {
          markdown_referrers: [
            { work_id: 'w1', title: '京都' },
            { work_id: 'w2', title: '咖啡' },
          ],
        },
        { markdown_referrers: [] },
      ]),
    ).toEqual(['京都', '咖啡']);
  });

  it('normalizes tags', () => {
    expect(normalizeTag('  京都 ', [])).toBe('京都');
    expect(normalizeTag('京都', ['京都'])).toBeNull();
    expect(normalizeTag('   ', [])).toBeNull();
    expect(normalizeTag('x'.repeat(80), [])).toHaveLength(64);
  });
});

describe('delete dialog says what really happens (QC-039)', () => {
  const copy = (id: string, title: string) => ({
    work_id: id,
    title,
    role: 'body' as const,
    position: 0,
    independent_copy: true,
  });
  it('only independent copies: the posts are not affected', () => {
    const impact = deleteImpact([
      { works: [copy('w1', '京都'), copy('w2', '咖啡')], variants: [] },
    ]);
    expect(impact.breaking).toEqual([]);
    expect(deleteImpactText(impact)).toBe(
      '文章中的圖片是獨立複本，不受影響；這些作品的素材清單會移除此項，30 天內恢復即補回。',
    );
    expect(deletedToast(impact)).toBe('已移到最近刪除 · 文章中的圖片不受影響');
    expect(
      deleteImpactText(deleteImpact([{ works: [copy('w1', '京都')], variants: [] }])),
    ).toContain('這件作品的素材清單');
  });

  it('covers, videos, platform versions and direct links really go missing, named', () => {
    const impact = deleteImpact([
      {
        works: [
          copy('w1', '京都'),
          { work_id: 'w2', title: '書房', role: 'cover', position: 0, independent_copy: false },
          // A reference from an older service without the flag counts as missing.
          { work_id: 'w3', title: '舊作品', role: 'body', position: 0 },
        ],
        variants: [{ work_id: 'w4', title: '咖啡', platform: 'xiaohongshu', usage: 'cover' }],
      },
    ]);
    expect(impact.breaking.map((w) => w.title)).toEqual(['書房', '舊作品', '咖啡']);
    expect(impact.safe.map((w) => w.title)).toEqual(['京都']);
    expect(deleteImpactText(impact)).toBe(
      '「書房」、「舊作品」、「咖啡」 會顯示為缺圖，30 天內恢復即自動補回。「京都」 中的圖片是獨立複本，不受影響。',
    );
    expect(deletedToast(impact)).toBe('已移到最近刪除 · 部分作品顯示為缺圖');
  });

  it('a work with a copied body image but also a cover counts as missing', () => {
    const impact = deleteImpact([
      {
        works: [
          copy('w1', '京都'),
          { work_id: 'w1', title: '京都', role: 'cover', position: 0, independent_copy: false },
        ],
        variants: [],
      },
    ]);
    expect(impact).toEqual({ safe: [], breaking: [{ work_id: 'w1', title: '京都' }] });
  });

  it('reads a batch asset_in_use answer', () => {
    const err = apiError(409, 'asset_in_use', {
      assets: [
        { id: 'a1', references: { works: [copy('w1', '京都')], variants: [] } },
        { id: 'a2', references: { works: [], variants: [] } },
      ],
    });
    const refs = batchInUseReferences(err);
    expect(refs).toHaveLength(2);
    expect(deleteImpact(refs).safe.map((w) => w.title)).toEqual(['京都']);
    expect(batchInUseReferences(apiError(409, 'asset_in_trash'))).toEqual([]);
  });
});

describe('rebaseEdits: never overwrite a field changed elsewhere', () => {
  const base = asset({ revision: 1, note: 'a', alt_text: null });
  it('keeps my edit when the other change touched another field', () => {
    const latest = asset({ revision: 2, note: 'a', alt_text: '別處加的' });
    expect(rebaseEdits(base, latest, { note: '我的' })).toEqual({
      edits: { note: '我的' },
      conflicts: [],
    });
  });
  it('reports a conflict when both changed the same field', () => {
    const latest = asset({ revision: 2, note: '別處的' });
    expect(rebaseEdits(base, latest, { note: '我的' })).toEqual({ edits: {}, conflicts: ['note'] });
  });
  it('drops an edit that already matches', () => {
    const latest = asset({ revision: 2, note: '我的' });
    expect(rebaseEdits(base, latest, { note: '我的' })).toEqual({ edits: {}, conflicts: [] });
  });
});

class FakeAssets {
  current: AssetRecord;
  updates: { base: number | undefined; fields: Record<string, unknown> }[] = [];
  /** Make the next update lose a race to this version. */
  raceWith: AssetRecord | null = null;
  constructor(a: AssetRecord) {
    this.current = a;
  }
  client = {
    assets: {
      get: () => Promise.resolve(this.current),
      update: (_id: string, input: Record<string, unknown>) => {
        const { base_revision, ...fields } = input;
        this.updates.push({ base: base_revision as number | undefined, fields });
        if (this.raceWith !== null) {
          this.current = this.raceWith;
          this.raceWith = null;
        }
        if (base_revision !== this.current.revision) {
          return Promise.reject(apiError(409, 'revision_conflict'));
        }
        this.current = { ...this.current, ...fields, revision: (this.current.revision ?? 0) + 1 };
        return Promise.resolve(this.current);
      },
    },
  } as unknown as ConstructorParameters<typeof AssetEditor>[0];
}

describe('AssetEditor autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves after a pause with base_revision and reports saved', async () => {
    const svc = new FakeAssets(asset());
    const saved: AssetRecord[] = [];
    const ed = new AssetEditor(svc.client, svc.current, (a) => saved.push(a), 600);
    ed.change('note', '第 2 段有風扇聲');
    ed.change('alt_text', '清晨竹林');
    expect(ed.getSnapshot().status).toBe('pending');
    expect(ed.value('note')).toBe('第 2 段有風扇聲');
    await vi.advanceTimersByTimeAsync(600);
    expect(svc.updates).toEqual([
      { base: 1, fields: { note: '第 2 段有風扇聲', alt_text: '清晨竹林' } },
    ]);
    expect(ed.getSnapshot()).toMatchObject({ status: 'saved', edits: {} });
    expect(ed.getSnapshot().asset.revision).toBe(2);
    expect(saved).toHaveLength(1);
  });

  it('undoing a change back to the saved value saves nothing', async () => {
    const svc = new FakeAssets(asset({ note: 'a' }));
    const ed = new AssetEditor(svc.client, svc.current, undefined, 600);
    ed.change('note', 'b');
    ed.change('note', 'a');
    expect(ed.getSnapshot().status).toBe('saved');
    await vi.advanceTimersByTimeAsync(1000);
    expect(svc.updates).toEqual([]);
  });

  it('on 409 rebases onto the newer version when another field changed', async () => {
    const svc = new FakeAssets(asset());
    svc.raceWith = asset({ revision: 2, tags: ['京都'] });
    const ed = new AssetEditor(svc.client, svc.current, undefined, 600);
    ed.change('note', '我的備註');
    await ed.flush();
    expect(svc.updates.map((u) => u.base)).toEqual([1, 2]);
    expect(ed.getSnapshot()).toMatchObject({ status: 'saved', conflict: null });
    expect(svc.current).toMatchObject({ note: '我的備註', tags: ['京都'], revision: 3 });
  });

  it('on 409 for the same field asks, and 用最新的 drops my value', async () => {
    const svc = new FakeAssets(asset());
    svc.raceWith = asset({ revision: 2, note: '別處的備註' });
    const ed = new AssetEditor(svc.client, svc.current, undefined, 600);
    ed.change('note', '我的備註');
    await ed.flush();
    expect(ed.getSnapshot().status).toBe('conflict');
    expect(ed.getSnapshot().conflict?.fields).toEqual(['note']);
    // Nothing more is written while the question is open.
    ed.change('alt_text', 'x');
    expect(svc.updates).toHaveLength(1);
    await ed.resolve('theirs');
    expect(ed.getSnapshot()).toMatchObject({ status: 'saved', conflict: null });
    expect(ed.value('note')).toBe('別處的備註');
    expect(svc.current.note).toBe('別處的備註');
  });

  it('用我的 writes my value over the newer one on purpose', async () => {
    const svc = new FakeAssets(asset());
    svc.raceWith = asset({ revision: 2, note: '別處的備註' });
    const ed = new AssetEditor(svc.client, svc.current, undefined, 600);
    ed.change('note', '我的備註');
    await ed.flush();
    await ed.resolve('mine');
    expect(svc.updates.at(-1)).toEqual({ base: 2, fields: { note: '我的備註' } });
    expect(ed.getSnapshot()).toMatchObject({ status: 'saved', conflict: null });
  });

  it('shows other errors and keeps the edit', async () => {
    const svc = new FakeAssets(asset({ deleted_at: '2026-11-19T00:00:00Z' }));
    svc.client.assets.update = () => Promise.reject(apiError(409, 'asset_in_trash'));
    const ed = new AssetEditor(svc.client, svc.current, undefined, 600);
    ed.change('note', 'x');
    await ed.flush();
    expect(ed.getSnapshot()).toMatchObject({ status: 'error', error: '這個素材已在最近刪除' });
    expect(ed.value('note')).toBe('x');
  });

  it('takes a newer version from the list only when nothing is unsaved', () => {
    const svc = new FakeAssets(asset());
    const ed = new AssetEditor(svc.client, svc.current, undefined, 600);
    ed.adopt(asset({ revision: 2, note: '外部' }));
    expect(ed.value('note')).toBe('外部');
    ed.change('alt_text', '我的');
    ed.adopt(asset({ revision: 3, note: '又一次' }));
    expect(ed.value('note')).toBe('外部');
    ed.adopt(asset({ revision: 1, note: '舊的' }));
    expect(ed.getSnapshot().asset.revision).toBe(2);
  });
});
