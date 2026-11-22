import { findMatches, matchesSearch } from '@qiu-creator/domain/search';
import type { Prompt, PromptScene } from '@qiu-creator/contracts';
import type { MessageKey } from '@qiu-creator/i18n';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { pickerEntries, useAiLibrary, type PickerEntry } from './ai-library.js';
import { t } from './i18n.js';
import { Icon, type IconName } from './Icon.js';

/**
 * Prompt 快選 (QC-075, PT-20261122-003), opened from the toolbar's 「Prompt」
 * (⌘K). One field both searches the library and takes a typed instruction:
 * recently used prompts first, then those for selected text, then the others
 * dimmed (shown, not hidden, so it is clear why they cannot be used here).
 * Typed text that is not a prompt's name can be sent as is (↩) or saved as a
 * new prompt in place. ↑↓ move, ↩ applies, esc closes.
 */

export const SCENE_ICON: Readonly<Record<PromptScene, IconName>> = {
  selection: 'lines',
  full: 'doc',
  title: 'tag',
  image: 'image',
};
export const SCENE_LABEL: Readonly<Record<PromptScene, MessageKey>> = {
  selection: 'ai.sceneSelection',
  full: 'ai.sceneFull',
  title: 'ai.sceneTitle',
  image: 'ai.sceneImage',
};

/** The name with the search hits marked (pinyin hits mark the matching characters). */
export function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim();
  if (q === '') return text;
  const hits = findMatches(text, q);
  if (hits.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start > at) out.push(text.slice(at, h.start));
    out.push(
      <mark key={h.start} className="hit">
        {text.slice(h.start, h.end)}
      </mark>,
    );
    at = h.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

type Row =
  | { kind: 'send'; text: string }
  | { kind: 'save'; text: string }
  | { kind: 'prompt'; entry: PickerEntry };

export function PromptPicker({
  scene,
  onApply,
  onSend,
  onManage,
  onSaved,
  onClose,
}: {
  scene: PromptScene;
  onApply: (prompt: Prompt) => void;
  /** A typed instruction, sent as is. */
  onSend: (instruction: string) => void;
  onManage: (() => void) | null;
  onSaved: (name: string) => void;
  onClose: () => void;
}) {
  const { library, state } = useAiLibrary();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState<{ name: string; group: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void library?.loadPrompts();
  }, [library]);

  const typed = q.trim();
  const prompts = state.prompts ?? [];
  const entries = pickerEntries(prompts, scene, typed, (text, query) => matchesSearch(text, query));
  const exact = prompts.some((p) => p.name === typed);
  const free = typed !== '' && !exact;
  const rows: Row[] = [
    ...(free
      ? [
          { kind: 'send' as const, text: typed },
          { kind: 'save' as const, text: typed },
        ]
      : []),
    ...entries.map((entry) => ({ kind: 'prompt' as const, entry })),
  ];
  const enabled = (r: Row) => r.kind !== 'prompt' || !r.entry.disabled;
  const current = Math.min(active, Math.max(0, rows.length - 1));

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-row="${String(current)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const choose = (r: Row) => {
    if (!enabled(r)) return;
    if (r.kind === 'send') onSend(r.text);
    else if (r.kind === 'save') {
      setSaving({ name: Array.from(r.text).slice(0, 20).join(''), group: '' });
      setError(null);
    } else onApply(r.entry.prompt);
  };

  const step = (by: number) => {
    if (rows.length === 0) return;
    let i = current;
    for (let n = 0; n < rows.length; n += 1) {
      i = (i + by + rows.length) % rows.length;
      const r = rows[i];
      if (r !== undefined && enabled(r)) break;
    }
    setActive(i);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || composing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[current];
      if (r !== undefined) choose(r);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const save = async () => {
    if (library === null || saving === null) return;
    const name = saving.name.trim();
    if (name === '') return;
    setBusy(true);
    setError(null);
    try {
      await library.createPrompt({
        name,
        content: typed,
        scene,
        group: saving.group.trim() === '' ? null : saving.group.trim(),
      });
      setSaving(null);
      onSaved(name);
    } catch {
      setError(t('ai.promptSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (saving !== null)
    return (
      <form
        className="qpop__save"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            setSaving(null);
          }
        }}
      >
        <span className="qpop__hd">{t('ai.promptSaveAs')}</span>
        <label className="qpop__field">
          <span>{t('ai.promptName')}</span>
          <input
            // The name is what this step asks for.
            autoFocus
            className="input"
            value={saving.name}
            maxLength={40}
            onChange={(e) => {
              setSaving({ ...saving, name: e.target.value });
            }}
          />
        </label>
        <label className="qpop__field">
          <span>{t('ai.promptGroup')}</span>
          <input
            className="input"
            value={saving.group}
            maxLength={40}
            placeholder={t('ai.promptGroupNone')}
            list="qc-prompt-groups"
            onChange={(e) => {
              setSaving({ ...saving, group: e.target.value });
            }}
          />
          <datalist id="qc-prompt-groups">
            {[...new Set(prompts.map((p) => p.group).filter((g): g is string => g !== null))].map(
              (g) => (
                <option key={g} value={g} />
              ),
            )}
          </datalist>
        </label>
        {error !== null && (
          <span className="qpop__err" role="alert">
            {error}
          </span>
        )}
        <span className="qpop__actions">
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => {
              setSaving(null);
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="btn btn--primary btn--small"
            disabled={busy || saving.name.trim() === ''}
          >
            {t('common.save')}
          </button>
        </span>
      </form>
    );

  let shownSection: string | null = null;
  const section = (r: Row): string | null => {
    if (r.kind !== 'prompt') return null;
    if (r.entry.recent) return t('ai.pickerRecent');
    return r.entry.disabled
      ? t('ai.pickerOther')
      : t('ai.pickerForScene', { scene: t(SCENE_LABEL[scene]) });
  };

  return (
    <div className="qpop__list qpop__list--picker">
      <label className="qpop__search">
        <Icon name="prompt" size={14} />
        <input
          // The picker opens to type into.
          autoFocus
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls="qc-prompt-picker"
          aria-activedescendant={rows.length === 0 ? undefined : `qc-prompt-row-${String(current)}`}
          aria-label={t('ai.pickerSearch')}
          placeholder={t('ai.pickerSearch')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onCompositionStart={() => {
            setComposing(true);
          }}
          onCompositionEnd={() => {
            setComposing(false);
          }}
          onKeyDown={onKey}
        />
      </label>
      <div
        id="qc-prompt-picker"
        role="listbox"
        aria-label="Prompt"
        className="qpop__scroll"
        ref={list}
      >
        {state.prompts === null && !state.failed && (
          <span className="qpop__empty">{t('common.loading')}</span>
        )}
        {state.failed && <span className="qpop__empty">{t('ai.pickerFailed')}</span>}
        {rows.map((r, i) => {
          const head = section(r);
          const header = head !== null && head !== shownSection ? head : null;
          if (head !== null) shownSection = head;
          const on = i === current;
          const cls = `qpop__o${on ? ' is-on' : ''}`;
          const common = {
            id: `qc-prompt-row-${String(i)}`,
            'data-row': i,
            role: 'option' as const,
            'aria-selected': on,
            className: cls,
            onMouseDown: (e: MouseEvent) => {
              e.preventDefault();
            },
            onMouseEnter: () => {
              if (enabled(r)) setActive(i);
            },
            onClick: () => {
              choose(r);
            },
          };
          return (
            <div key={r.kind === 'prompt' ? r.entry.prompt.id : r.kind} className="qpop__rowwrap">
              {header !== null && <span className="qpop__hd">{header}</span>}
              {r.kind === 'send' ? (
                <div {...common}>
                  <Icon name="send" size={14} />
                  <span className="qpop__name">{t('ai.pickerSend', { text: r.text })}</span>
                  <kbd>↩</kbd>
                </div>
              ) : r.kind === 'save' ? (
                <div {...common}>
                  <Icon name="plus" size={14} />
                  <span className="qpop__name">{t('ai.pickerSaveAs')}</span>
                </div>
              ) : (
                <div
                  {...common}
                  aria-disabled={r.entry.disabled}
                  className={r.entry.disabled ? `${cls} is-off` : cls}
                  title={
                    r.entry.disabled
                      ? t('ai.pickerOtherTip', { scene: t(SCENE_LABEL[r.entry.prompt.scene]) })
                      : undefined
                  }
                >
                  <Icon name={SCENE_ICON[r.entry.prompt.scene]} size={14} />
                  <span className="qpop__name">
                    <Highlighted text={r.entry.prompt.name} query={typed} />
                  </span>
                  {r.entry.prompt.scene !== scene && (
                    <span className="qpop__d">{t(SCENE_LABEL[r.entry.prompt.scene])}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {state.prompts !== null && rows.length === 0 && (
          <span className="qpop__empty">{t('ai.pickerNone')}</span>
        )}
      </div>
      <span className="qpop__ft">
        <span>↑↓ {t('ai.pickerMove')}</span>
        <span>↩ {t('ai.pickerApply')}</span>
        {onManage !== null && (
          <button type="button" className="qpop__link" onClick={onManage}>
            {t('ai.pickerManage')} ›
          </button>
        )}
      </span>
    </div>
  );
}
