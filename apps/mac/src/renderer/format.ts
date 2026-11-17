import type {
  AssetKind,
  AssetRecord,
  RevisionSource,
  Work,
  WorkStatus,
  WorkType,
} from '@qiu-creator/contracts';
import type { IconName } from './Icon.js';
import type { SaveStatus } from './work-session.js';

export const SAVE_STATUS: Readonly<Record<SaveStatus, { label: string; tone: ChipTone }>> = {
  saved: { label: '已儲存', tone: 'ok' },
  dirty: { label: '未儲存', tone: 'neutral' },
  saving: { label: '儲存中', tone: 'neutral' },
  error: { label: '儲存失敗', tone: 'bad' },
  conflict: { label: '衝突', tone: 'bad' },
};

export type ChipTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent';

export const REVISION_SOURCE_LABEL: Readonly<Record<RevisionSource, string>> = {
  create: '建立',
  edit: 'Mac 編輯',
  external: '外部修改',
  restore: '恢復',
  ai_accepted: 'AI 採用',
};

export const WORK_STATUS: Readonly<Record<WorkStatus, { label: string; tone: ChipTone }>> = {
  drafting: { label: '創作中', tone: 'neutral' },
  in_review: { label: '待審核', tone: 'warn' },
  ready: { label: '待發布', tone: 'accent' },
  published: { label: '已發布', tone: 'ok' },
};

export const WORK_TYPE: Readonly<Record<WorkType, { label: string; icon: IconName }>> = {
  article: { label: '長文', icon: 'doc' },
  image: { label: '圖文', icon: 'image' },
  video: { label: '視頻', icon: 'video' },
  mixed: { label: '混合', icon: 'mixed' },
};

/** Where a work came from, in the library's words. */
export function sourceLabel(work: Pick<Work, 'source' | 'storage_mode'>): string {
  if (work.storage_mode === 'external') return '外部掛載';
  if (work.source === 'mac-app') return 'Mac';
  if (work.source === 'cli') return 'CLI';
  if (work.source === 'api' || work.source.startsWith('api:')) return 'Agent API';
  return work.source;
}

const time = new Intl.DateTimeFormat('zh-TW', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const date = new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' });

/** 剛剛 / 14:32 / 昨天 / 11/14 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const diff = now.getTime() - d.getTime();
  if (diff >= 0 && diff < 60_000) return '剛剛';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfToday) return time.format(d);
  if (d.getTime() >= startOfToday - 86_400_000) return '昨天';
  return date.format(d);
}

/**
 * Length of a Markdown document in "字": each CJK character counts as one,
 * each run of Latin letters or digits counts as one word; Markdown syntax
 * characters are ignored.
 */
export function countWords(markdown: string): number {
  const cjk = markdown.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  );
  const words = markdown.match(/[\p{Script=Latin}\p{Nd}]+/gu);
  return (cjk?.length ?? 0) + (words?.length ?? 0);
}

export const ASSET_KIND: Readonly<Record<AssetKind, { label: string; icon: IconName }>> = {
  image: { label: '圖片', icon: 'image' },
  video: { label: '視頻', icon: 'video' },
  audio: { label: '音訊', icon: 'audio' },
  markdown: { label: 'Markdown', icon: 'doc' },
  other: { label: '其他', icon: 'file' },
};

/** 1 KB = 1000 bytes, as Finder shows sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const text = digits === 0 ? value.toFixed(0) : value.toFixed(digits).replace(/\.?0+$/, '');
  return `${text} ${units[unit] ?? 'TB'}`;
}

/** 252.4 → 4:12; 3725 → 1:02:05 */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatDimensions(width: number | null, height: number | null): string | null {
  return width === null || height === null ? null : `${width} × ${height}`;
}

/** Display name: the uploaded file name, else the stored file name. */
export function assetName(asset: Pick<AssetRecord, 'original_name' | 'path'>): string {
  if (asset.original_name !== null && asset.original_name !== '') return asset.original_name;
  return asset.path.split('/').pop() ?? asset.path;
}

/** First and last characters of a hash, for display next to a copy button. */
export function shortHash(sha256: string): string {
  return sha256.length <= 12 ? sha256 : `${sha256.slice(0, 6)}…${sha256.slice(-4)}`;
}
