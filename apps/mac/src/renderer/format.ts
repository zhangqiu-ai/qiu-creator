import type {
  AssetKind,
  AssetRecord,
  RevisionSource,
  Work,
  WorkStatus,
  WorkType,
} from '@qiu-creator/contracts';
import { t } from './i18n.js';
import type { IconName } from './Icon.js';
import type { SaveStatus } from './work-session.js';

export const SAVE_STATUS: Readonly<Record<SaveStatus, { label: string; tone: ChipTone }>> = {
  saved: {
    get label() {
      return t('format.saveSaved');
    },
    tone: 'ok',
  },
  dirty: {
    get label() {
      return t('format.saveDirty');
    },
    tone: 'neutral',
  },
  saving: {
    get label() {
      return t('format.saveSaving');
    },
    tone: 'neutral',
  },
  error: {
    get label() {
      return t('format.saveError');
    },
    tone: 'bad',
  },
  conflict: {
    get label() {
      return t('format.saveConflict');
    },
    tone: 'bad',
  },
};

export type ChipTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent';

export const REVISION_SOURCE_LABEL: Readonly<Record<RevisionSource, string>> = {
  get create() {
    return t('format.revCreate');
  },
  get edit() {
    return t('format.revEdit');
  },
  get external() {
    return t('format.revExternal');
  },
  get restore() {
    return t('format.revRestore');
  },
  get ai_accepted() {
    return t('format.revAiAccepted');
  },
};

export const WORK_STATUS: Readonly<Record<WorkStatus, { label: string; tone: ChipTone }>> = {
  drafting: {
    get label() {
      return t('format.statusDrafting');
    },
    tone: 'neutral',
  },
  in_review: {
    get label() {
      return t('format.statusInReview');
    },
    tone: 'warn',
  },
  ready: {
    get label() {
      return t('format.statusReady');
    },
    tone: 'accent',
  },
  published: {
    get label() {
      return t('format.statusPublished');
    },
    tone: 'ok',
  },
};

export const WORK_TYPE: Readonly<Record<WorkType, { label: string; icon: IconName }>> = {
  article: {
    get label() {
      return t('format.typeArticle');
    },
    icon: 'doc',
  },
  image: {
    get label() {
      return t('format.typeImage');
    },
    icon: 'image',
  },
  video: {
    get label() {
      return t('format.typeVideo');
    },
    icon: 'video',
  },
  mixed: {
    get label() {
      return t('format.typeMixed');
    },
    icon: 'mixed',
  },
};

/** Where a work came from, in the library's words. */
export function sourceLabel(work: Pick<Work, 'source' | 'storage_mode'>): string {
  if (work.storage_mode === 'external') return t('format.sourceExternal');
  if (work.source === 'mac-app') return 'Mac';
  if (work.source === 'cli') return 'CLI';
  if (work.source === 'api' || work.source.startsWith('api:')) return 'Agent API';
  return work.source;
}

/** 剛剛 / 14:32 / 昨天 / 11/14, in the current language (QC-042: through Intl). */
export { formatWhen } from './i18n.js';

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
  image: {
    get label() {
      return t('format.kindImage');
    },
    icon: 'image',
  },
  video: {
    get label() {
      return t('format.kindVideo');
    },
    icon: 'video',
  },
  audio: {
    get label() {
      return t('format.kindAudio');
    },
    icon: 'audio',
  },
  markdown: { label: 'Markdown', icon: 'doc' },
  other: {
    get label() {
      return t('format.kindOther');
    },
    icon: 'file',
  },
};

/** 1 KB = 1000 bytes, as Finder shows sizes; digits follow the current language. */
export { formatBytes } from './i18n.js';

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

/** `/Users/me/Documents/寫作` → `~/Documents/寫作` when inside `userHome`. */
export function tildePath(path: string, userHome: string | null): string {
  if (userHome === null || userHome === '') return path;
  const home = userHome.replace(/\/+$/, '');
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
