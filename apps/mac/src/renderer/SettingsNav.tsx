import { Icon, type IconName } from './Icon.js';
import type { ServiceTone } from './sidebar-prefs.js';

export type SettingsCategory = 'appearance' | 'service' | 'backup' | 'ai' | 'folders' | 'about';

export const CATEGORIES: readonly { key: SettingsCategory; label: string; icon: IconName }[] = [
  { key: 'appearance', label: '外觀', icon: 'appearance' },
  { key: 'service', label: '本機服務', icon: 'server' },
  { key: 'backup', label: '備份與還原', icon: 'history' },
  { key: 'ai', label: 'AI 服務', icon: 'spark' },
  { key: 'folders', label: '資料夾', icon: 'folder' },
  { key: 'about', label: '關於', icon: 'info' },
];

/** The heading each category scrolls to (and that the sections already label themselves with). */
export const CATEGORY_HEADING: Readonly<Record<SettingsCategory, string>> = {
  appearance: 'set-appearance-h',
  service: 'set-service',
  backup: 'set-backup',
  ai: 'set-ai',
  folders: 'set-folders',
  about: 'set-about',
};

/**
 * The category being read: the last one whose heading has scrolled to within
 * 48 px of the top of the scrolling body; at the very bottom, the last one
 * (a short final section never reaches the top).
 */
export function pickCategory(
  headingTops: readonly { key: SettingsCategory; top: number }[],
  scroll: { top: number; height: number; scrollHeight: number },
): SettingsCategory {
  if (scroll.top + scroll.height >= scroll.scrollHeight - 2) {
    return headingTops.at(-1)?.key ?? 'appearance';
  }
  let current: SettingsCategory = headingTops[0]?.key ?? 'appearance';
  for (const h of headingTops) {
    if (h.top - scroll.top <= 48) current = h.key;
  }
  return current;
}

export function currentCategory(body: HTMLElement): SettingsCategory {
  const bodyTop = body.getBoundingClientRect().top;
  const tops: { key: SettingsCategory; top: number }[] = [];
  for (const c of CATEGORIES) {
    const el = document.getElementById(CATEGORY_HEADING[c.key]);
    if (el !== null) {
      tops.push({ key: c.key, top: el.getBoundingClientRect().top - bodyTop + body.scrollTop });
    }
  }
  return pickCategory(tops, {
    top: body.scrollTop,
    height: body.clientHeight,
    scrollHeight: body.scrollHeight,
  });
}

/** Left category list of 設定 (in-page anchors; the content scrolls on its own). */
export function SettingsNav({
  current,
  tone,
  onPick,
}: {
  current: SettingsCategory;
  /** The sidebar dot's tone (one source); null while the first check runs. */
  tone: ServiceTone | null;
  onPick: (cat: SettingsCategory) => void;
}) {
  return (
    <nav className="set-nav" aria-label="設定分類">
      {CATEGORIES.map((c) => (
        <button
          key={c.key}
          type="button"
          className="set-nav__item"
          aria-current={current === c.key ? 'true' : undefined}
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
              aria-label={tone === 'ok' ? '服務正常' : tone === 'bad' ? '服務異常' : '還原中'}
            />
          )}
        </button>
      ))}
    </nav>
  );
}
