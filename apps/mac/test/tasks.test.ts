import type { ImportJobRecord } from '@qiu-creator/contracts';
import { describe, expect, it } from 'vitest';
import {
  abbreviateHome,
  assetServicePath,
  forwardableRange,
  resolveInsideHome,
} from '../src/main/assets.js';
import { assetMediaUrl, thumbnailUrl, type UploadItem } from '../src/shared/bridge.js';
import { urlRejectedText, validateImportUrl } from '../src/renderer/ImportsPage.js';
import { mountErrorText, sortMounts } from '../src/renderer/SettingsPage.js';
import { t } from '../src/renderer/i18n.js';
import { countRows, filterRows, jobRow, taskRows, uploadRow } from '../src/renderer/tasks.js';
import { sortTokens } from '../src/renderer/TokensPanel.js';
import { ApiError } from '@qiu-creator/api-client';
import type { ApiToken, Mount } from '@qiu-creator/contracts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function job(patch: Partial<ImportJobRecord>): ImportJobRecord {
  return {
    id: ID,
    method: 'url',
    status: 'queued',
    progress: 0,
    retry_count: 0,
    error: null,
    idempotency_key: null,
    created_at: '2026-11-17T01:00:00.000Z',
    updated_at: '2026-11-17T01:00:00.000Z',
    url: 'https://cdn.example.com/media/clip-77.mp4',
    filename: null,
    error_code: null,
    result_asset_id: null,
    result_work_id: null,
    link_work_id: null,
    link_role: null,
    created_by: 'owner',
    ...patch,
  };
}

function upload(patch: Partial<UploadItem>): UploadItem {
  return {
    id: 'u1',
    filename: 'IMG_2041.MOV',
    bytes: 1_100_000_000,
    sentBytes: 0,
    state: 'queued',
    transport: 'tus',
    error: null,
    errorCode: null,
    result: null,
    createdAt: '2026-11-17T02:00:00.000Z',
    updatedAt: '2026-11-17T02:00:00.000Z',
    ...patch,
  };
}

describe('task rows', () => {
  it('names URL jobs after the file and shows the host and path', () => {
    const row = jobRow(job({}));
    expect(row.name).toBe('clip-77.mp4');
    expect(row.origin).toBe('cdn.example.com/media/clip-77.mp4');
    expect(row.label).toBe('排隊');
    expect(row.group).toBe('run');
  });

  it('labels SSRF refusals as blocked with a reason, and lets failures retry', () => {
    const blocked = jobRow(
      job({ status: 'failed', error_code: 'blocked_address', error: 'host 10.0.0.12 is local' }),
    );
    expect(blocked.label).toBe('已阻擋');
    expect(blocked.reason).toBe('內網或本機位址，已阻擋');
    expect(blocked.reasonDetail).toBe('host 10.0.0.12 is local');
    expect(blocked.canRetry).toBe(true);
    // QC-048: without a code the reason is generic; the service text only goes under 技術細節.
    const raw = jobRow(
      job({
        status: 'failed',
        error_code: null,
        error: 'fetch failed: Authorization: Bearer sk-abc',
      }),
    );
    expect(raw.reason).toBe(t('library.taskFailed'));
    expect(raw.reasonDetail).toBe('fetch failed: Authorization: Bearer sk-abc');
    const timeout = jobRow(job({ status: 'failed', error_code: 'timeout' }));
    expect(timeout.label).toBe('失敗');
    expect(timeout.reason).toBe('下載逾時');
  });

  it('shows indeterminate progress when the service reports none', () => {
    expect(jobRow(job({ status: 'running', progress: 0 })).progress).toBeNull();
    expect(jobRow(job({ status: 'running', progress: 0.4 })).progress).toBe(0.4);
  });

  it('marks agent-created jobs', () => {
    expect(jobRow(job({ url: null, method: 'markdown', created_by: 'tok-1' })).origin).toBe(
      'Agent API',
    );
  });

  it('maps upload states, progress and reuse', () => {
    const running = uploadRow(upload({ state: 'uploading', sentBytes: 242_000_000 }));
    expect(running.progress).toBeCloseTo(0.22);
    expect(running.canCancel).toBe(true);
    expect(running.size).toBe('1.1 GB');
    expect(running.origin).toBe('Mac 上傳 · 可續傳');

    const cancelled = uploadRow(upload({ state: 'cancelled', sentBytes: 100 }));
    expect(cancelled.canRetry).toBe(true);
    expect(cancelled.group).toBe('fail');

    const asset = {
      id: ID,
      kind: 'image' as const,
      path: 'library/assets/x.png',
      sha256: 'a'.repeat(64),
      mime_type: 'image/png',
      bytes: 1,
      duration: null,
      width: 1,
      height: 1,
      origin: 'upload' as const,
      created_at: '2026-11-17T00:00:00.000Z',
      original_name: 'x.png',
      codec: null,
      metadata_status: 'ready' as const,
      thumbnail_status: 'ready' as const,
      updated_at: '2026-11-17T00:00:00.000Z',
    };
    const reused = uploadRow(upload({ state: 'succeeded', result: { asset, deduplicated: true } }));
    expect(reused.label).toBe('已存在');
    expect(reused.reused).toBe(true);
    expect(reused.assetId).toBe(ID);

    const failed = uploadRow(
      upload({ state: 'failed', errorCode: 'unsupported_media_type', error: 'nope' }),
    );
    expect(failed.reason).toBe('不支援的檔案格式');
  });

  it('merges newest first, filters and counts by group', () => {
    const rows = taskRows(
      [
        job({ status: 'succeeded' }),
        job({ id: 'x', status: 'failed', created_at: '2026-11-17T03:00:00.000Z' }),
      ],
      [upload({ state: 'uploading' })],
    );
    expect(rows.map((r) => r.source)).toEqual(['job', 'upload', 'job']);
    expect(countRows(rows)).toEqual({ all: 3, run: 1, fail: 1, done: 1 });
    expect(filterRows(rows, 'fail').map((r) => r.id)).toEqual(['x']);
  });
});

describe('main-process asset helpers', () => {
  it('maps only thumbnail and stream URLs with a UUID', () => {
    expect(assetServicePath(thumbnailUrl(ID))).toEqual({
      resource: 'thumbnail',
      path: `/api/v1/assets/${ID}/thumbnail`,
    });
    expect(assetServicePath(assetMediaUrl(ID))).toEqual({
      resource: 'stream',
      path: `/api/v1/assets/${ID}/stream`,
    });
    expect(assetServicePath('qc-asset://thumbnail/../works')).toBeNull();
    expect(assetServicePath(`qc-asset://original/${ID}`)).toBeNull();
    expect(assetServicePath(`qc-asset://stream/${ID}?x=1`)).toBeNull();
    expect(assetServicePath(`https://stream/${ID}`)).toBeNull();
  });

  it('forwards only a single plain byte range', () => {
    expect(forwardableRange('bytes=0-')).toBe('bytes=0-');
    expect(forwardableRange('bytes=100-199')).toBe('bytes=100-199');
    expect(forwardableRange('bytes=-500')).toBe('bytes=-500');
    expect(forwardableRange('bytes=-')).toBeNull();
    expect(forwardableRange('bytes=0-1,5-9')).toBeNull();
    expect(forwardableRange('items=0-1')).toBeNull();
    expect(forwardableRange(null)).toBeNull();
  });

  it('keeps reveal paths inside CREATORHUB_HOME', () => {
    expect(resolveInsideHome('/tmp/home', 'library/assets/a.png')).toBe(
      '/tmp/home/library/assets/a.png',
    );
    expect(resolveInsideHome('/tmp/home', '../etc/passwd')).toBeNull();
    expect(resolveInsideHome('/tmp/home', '/etc/passwd')).toBeNull();
    expect(resolveInsideHome('/tmp/home', '')).toBeNull();
  });

  it('abbreviates the home directory', () => {
    expect(abbreviateHome('/Users/me/CreatorHub', '/Users/me')).toBe('~/CreatorHub');
    expect(abbreviateHome('/Volumes/X/CreatorHub', '/Users/me')).toBe('/Volumes/X/CreatorHub');
  });
});

describe('form and list helpers', () => {
  it('validates import URLs', () => {
    expect(validateImportUrl('')).toBe('請輸入網址');
    expect(validateImportUrl('ftp://x.example/a')).toBe('只支援 http 或 https 網址');
    expect(validateImportUrl('not a url')).toBe('網址格式不正確');
    expect(validateImportUrl(' https://example.com/a.jpg ')).toBeNull();
  });

  it('explains URLs the service refuses before queuing', () => {
    const blocked = new ApiError(
      400,
      {
        error: {
          code: 'url_rejected',
          message: 'address 10.0.0.12 is not publicly routable',
          details: { reason: 'blocked_address' },
        },
      },
      'x',
    );
    expect(urlRejectedText(blocked)).toBe('內網或本機位址，已阻擋。只能匯入公開網址。');
    expect(
      urlRejectedText(new ApiError(400, { error: { code: 'url_rejected', message: 'x' } }, 'x')),
    ).toBe('這個網址不能匯入');
  });

  it('explains mount rejections', () => {
    const rejected = (message: string) =>
      new ApiError(400, { error: { code: 'mount_rejected', message } }, message);
    expect(mountErrorText(rejected('this folder is already mounted'))).toBe('這個資料夾已經掛載');
    expect(
      mountErrorText(
        rejected('folders inside or containing the CreatorHub data folder cannot be mounted'),
      ),
    ).toBe('不能掛載托管目錄，或包含托管目錄的資料夾');
    expect(mountErrorText(rejected('overlaps the existing mount "寫作"'))).toBe(
      '和已掛載的資料夾重疊',
    );
    expect(mountErrorText(new TypeError('fetch failed'))).toBe('無法掛載，請確認本機服務是否運行');
  });

  it('sorts removed mounts and revoked tokens last', () => {
    const mount = (name: string, status: Mount['status']): Mount => ({
      id: name,
      name,
      root_path: `/x/${name}`,
      status,
      work_count: 0,
      last_scan_at: null,
      last_error: null,
      created_at: '2026-11-17T00:00:00.000Z',
      updated_at: '2026-11-17T00:00:00.000Z',
    });
    expect(
      sortMounts([mount('a', 'removed'), mount('c', 'active'), mount('b', 'unavailable')]).map(
        (m) => m.name,
      ),
    ).toEqual(['b', 'c', 'a']);

    const token = (name: string, created: string, revoked: string | null): ApiToken => ({
      id: name,
      name,
      prefix: 'qc_',
      scopes: ['read'],
      created_at: created,
      last_used_at: null,
      revoked_at: revoked,
    });
    expect(
      sortTokens([
        token('old', '2026-11-01T00:00:00.000Z', null),
        token('gone', '2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z'),
        token('new', '2026-11-12T00:00:00.000Z', null),
      ]).map((t) => t.name),
    ).toEqual(['new', 'old', 'gone']);
  });
});
