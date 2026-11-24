import { Icon, type IconName } from './Icon.js';
import type { ServiceTone } from './sidebar-prefs.js';
import type { MessageKey } from '@qiu-creator/i18n';
import { t } from './i18n.js';

export type SettingsCategory =
  'appearance' | 'service' | 'backup' | 'ai' | 'agents' | 'folders' | 'about';

const cat = (key: SettingsCategory, label: MessageKey, icon: IconName) => ({
  key,
  get label() {
    return t(label);
  },
  icon,
});

export const CATEGORIES: readonly { key: SettingsCategory; label: string; icon: IconName }[] = [
  cat('appearance', 'settings.catAppearance', 'appearance'),
  cat('service', 'settings.catService', 'server'),
  cat('backup', 'settings.catBackup', 'history'),
  cat('ai', 'settings.catAi', 'spark'),
  cat('agents', 'agents.catAgents', 'robot'),
  cat('folders', 'settings.catFolders', 'folder'),
  cat('about', 'settings.catAbout', 'info'),
];

/** Each category page's title; focus moves there when the page is shown. */
export const CATEGORY_HEADING: Readonly<Record<SettingsCategory, string>> = {
  appearance: 'set-appearance-h',
  service: 'set-service',
  backup: 'set-backup',
  ai: 'set-ai',
  agents: 'set-agents',
  folders: 'set-folders',
  about: 'set-about',
};

const LAST_KEY = 'qc.settings.category';

/** The category shown last (QC-057: 設定 reopens where it was), or 外觀. */
export function readLastCategory(): SettingsCategory {
  try {
    const v = localStorage.getItem(LAST_KEY);
    return CATEGORIES.some((c) => c.key === v) ? (v as SettingsCategory) : 'appearance';
  } catch {
    return 'appearance';
  }
}

export function writeLastCategory(cat: SettingsCategory): void {
  try {
    localStorage.setItem(LAST_KEY, cat);
  } catch {
    // a per-viewer convenience only
  }
}

/**
 * Left category list of 設定 (QC-057): each category is a page of its own;
 * picking one swaps the page on the right, nothing scrolls.
 */
export function SettingsNav({
  current,
  tone,
  aiTone = null,
  onPick,
}: {
  current: SettingsCategory;
  /** The sidebar dot's tone (one source); null while the first check runs. */
  tone: ServiceTone | null;
  /** AI 服務: red when a provider is broken, yellow when one needs attention (QC-057). */
  aiTone?: 'bad' | 'warn' | null;
  onPick: (cat: SettingsCategory) => void;
}) {
  return (
    <nav className="set-nav" aria-label={t('settings.categories')}>
      {CATEGORIES.map((c) => (
        <button
          key={c.key}
          type="button"
          className="set-nav__item"
          aria-current={current === c.key ? 'page' : undefined}
          onClick={() => {
            onPick(c.key);
          }}
        >
          <Icon name={c.icon} size={16} />
          <span className="set-nav__label">{c.label}</span>
          {c.key === 'service' && tone !== null && (
            <span
              className={`set-nav__dot set-nav__dot--${tone}`}
              role="img"
              aria-label={
                tone === 'ok'
                  ? t('settings.dotOk')
                  : tone === 'bad'
                    ? t('settings.dotBad')
                    : t('settings.dotRestoring')
              }
            />
          )}
          {c.key === 'ai' && aiTone !== null && (
            <span
              className={`set-nav__dot set-nav__dot--${aiTone === 'bad' ? 'bad' : 'warn'}`}
              role="img"
              aria-label={aiTone === 'bad' ? t('aiServices.navBad') : t('aiServices.navWarn')}
            />
          )}
        </button>
      ))}
    </nav>
  );
}
