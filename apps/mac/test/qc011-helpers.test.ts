import type { AssetRecord, Mount, WorkMediaResponse } from '@qiu-creator/contracts';
import { describe, expect, it, vi } from 'vitest';
import { groupAssets } from '../src/renderer/AssetsPage.js';
import { tildePath } from '../src/renderer/format.js';
import { isMissing } from '../src/renderer/LibraryPage.js';
import { placeholderImage, WorkMediaResolver } from '../src/renderer/media.js';
import { externalSource } from '../src/renderer/mounts.js';
import { addTags } from '../src/renderer/TagEditor.js';

const WORK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MOUNT = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

function mount(patch: Partial<Mount> = {}): Mount {
  return {
    id: MOUNT,
    name: '寫作',
    root_path: '/Users/me/Documents/寫作',
    status: 'active',
    work_count: 3,
    last_scan_at: null,
    last_error: null,
    created_at: '2026-11-17T00:00:00.000Z',
    updated_at: '2026-11-17T00:00:00.000Z',
    ...patch,
  };
}

function media(items: WorkMediaResponse['items'], expires: string): WorkMediaResponse {
  return { work_id: WORK, revision_id: WORK, items, expires_at: expires };
}

const ref = (src: string, patch: Partial<WorkMediaResponse['items'][number]> = {}) => ({
  src,
  status: 'resolved' as const,
  path: src,
  asset_id: null,
  kind: 'image' as const,
  mime_type: 'image/png',
  bytes: 1,
  url: `/media/v1/x?sig=${src}`,
  ...patch,
});

describe('WorkMediaResolver', () => {
  it('serves every image from one /media call until the URLs near expiry', async () => {
    let now = Date.parse('2026-11-17T00:00:00Z');
    const load = vi.fn(() =>
      Promise.resolve(media([ref('assets/a.png'), ref('assets/b.png')], '2026-11-17T01:00:00Z')),
    );
    const r = new WorkMediaResolver({ load, absolute: (u) => `http://svc${u}`, now: () => now });
    const [a, b] = await Promise.all([r.resolve('assets/a.png'), r.resolve('assets/b.png')]);
    expect(a).toBe('http://svc/media/v1/x?sig=assets/a.png');
    expect(b).toBe('http://svc/media/v1/x?sig=assets/b.png');
    expect(load).toHaveBeenCalledTimes(1);
    now = Date.parse('2026-11-17T00:59:45Z'); // inside the 30 s margin
    await r.resolve('assets/a.png');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('saves first when an image is not known yet, then refetches', async () => {
    const calls: string[] = [];
    let items = [ref('assets/a.png')];
    const r = new WorkMediaResolver({
      load: () => {
        calls.push('load');
        return Promise.resolve(media(items, '2099-01-01T00:00:00Z'));
      },
      absolute: (u) => u,
      beforeLookup: () => {
        calls.push('save');
        items = [ref('assets/a.png'), ref('assets/new.png')];
        return Promise.resolve();
      },
    });
    await r.resolve('assets/a.png');
    expect(await r.resolve('assets/new.png')).toContain('assets/new.png');
    expect(calls).toEqual(['load', 'save', 'load']);
  });

  it('shows placeholders for missing, rejected, unsupported and remote images', async () => {
    const r = new WorkMediaResolver({
      load: () =>
        Promise.resolve(
          media(
            [
              ref('a.png', { status: 'missing', url: null }),
              ref('../x.png', { status: 'rejected', url: null, path: null }),
              ref('b.svg', { status: 'unsupported', url: null }),
            ],
            '2099-01-01T00:00:00Z',
          ),
        ),
      absolute: (u) => u,
    });
    expect(decodeURIComponent(await r.resolve('a.png'))).toContain('找不到圖片');
    expect(decodeURIComponent(await r.resolve('../x.png'))).toContain('路徑不允許');
    expect(decodeURIComponent(await r.resolve('b.svg'))).toContain('不支援的格式');
    expect(decodeURIComponent(await r.resolve('https://cdn.example.com/a.jpg'))).toContain(
      '外部網址圖片未載入',
    );
    expect(await r.resolve('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('escapes paths inside the placeholder SVG', () => {
    expect(decodeURIComponent(placeholderImage('missing', '<script>&"'))).not.toContain('<script>');
  });

  it('falls back to a placeholder when the service is unreachable', async () => {
    const r = new WorkMediaResolver({
      load: () => Promise.reject(new TypeError('fetch failed')),
      absolute: (u) => u,
    });
    expect(await r.resolve('assets/a.png')).toMatch(/^data:image\/svg/);
  });
});

describe('external source labels', () => {
  const mounts = new Map([[MOUNT, mount()]]);
  it('names the mount and shows paths under ~', () => {
    expect(
      externalSource(
        { storage_mode: 'external', mount_id: MOUNT, external_path: '工具/評測.md' },
        mounts,
        '/Users/me',
      ),
    ).toEqual({
      label: '外部掛載 · 寫作',
      folder: '~/Documents/寫作',
      file: '~/Documents/寫作/工具/評測.md',
    });
  });

  it('is null for managed works and generic when the mount is unknown', () => {
    expect(externalSource({ storage_mode: 'managed' }, mounts, '/Users/me')).toBeNull();
    expect(
      externalSource(
        { storage_mode: 'external', mount_id: 'x', external_path: 'a.md' },
        mounts,
        null,
      ),
    ).toEqual({ label: '外部掛載', folder: null, file: 'a.md' });
  });

  it('abbreviates only real home prefixes', () => {
    expect(tildePath('/Users/me', '/Users/me')).toBe('~');
    expect(tildePath('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x');
    expect(tildePath('/Users/me/x', null)).toBe('/Users/me/x');
  });

  it('treats missing and unmounted files as 檔案遺失', () => {
    expect(isMissing({ external_state: 'missing' })).toBe(true);
    expect(isMissing({ external_state: 'unmounted' })).toBe(true);
    expect(isMissing({ external_state: 'present' })).toBe(false);
    expect(isMissing({})).toBe(false);
  });
});

describe('tags', () => {
  it('splits on commas and spaces, strips #, drops duplicates and empties', () => {
    expect(addTags(['旅行'], '#京都, 旅行，美食 、 ')).toEqual(['旅行', '京都', '美食']);
    expect(addTags([], '   ')).toEqual([]);
    expect(addTags([], 'x'.repeat(80))[0]).toHaveLength(64);
  });
});

describe('asset groups', () => {
  const asset = (id: string, mountId: string | null): AssetRecord => ({
    id,
    kind: 'image',
    path: `${id}.png`,
    sha256: 'a'.repeat(64),
    mime_type: 'image/png',
    bytes: 1,
    duration: null,
    width: 1,
    height: 1,
    origin: 'folder',
    created_at: '2026-11-17T00:00:00.000Z',
    original_name: null,
    codec: null,
    metadata_status: 'ready',
    thumbnail_status: 'ready',
    updated_at: '2026-11-17T00:00:00.000Z',
    mount_id: mountId,
  });

  it('puts managed assets first, then one group per mount', () => {
    const groups = groupAssets(
      [asset('m1', MOUNT), asset('a1', null), asset('m2', MOUNT), asset('a2', null)],
      new Map([[MOUNT, mount({ status: 'unavailable' })]]),
    );
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ['managed', ['a1', 'a2']],
      [MOUNT, ['m1', 'm2']],
    ]);
    expect(groups[1]?.mount?.status).toBe('unavailable');
  });
});
