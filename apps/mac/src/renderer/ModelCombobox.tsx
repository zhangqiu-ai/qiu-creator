import type { AiProviderModelsResponse, AiRelayModel } from '@qiu-creator/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { Chip } from './Chip.js';
import { ExitFade } from './motion.js';
import { formatWhen, t } from './i18n.js';
import { Icon } from './Icon.js';
import {
  describeModelListError,
  findModel,
  visibleModels,
  type ModelListProblem,
} from './model-list.js';
import { TechnicalDetails } from './TechnicalDetails.js';

type ListState =
  | { status: 'idle' }
  | { status: 'loading'; previous: AiProviderModelsResponse | null }
  | { status: 'ready'; data: AiProviderModelsResponse }
  | { status: 'error'; problem: ModelListProblem };

const KIND_LABEL = {
  chat: 'modelPicker.kindChat',
  image: 'modelPicker.kindImage',
  unknown: 'modelPicker.kindUnknown',
} as const;

/**
 * A searchable model picker with a typed fallback (QC-054), reusable by the
 * settings redesign (QC-057): the list is fetched only when it is opened or
 * 重新整理 is pressed (it goes to the user's relay), chat models by default
 * with 顯示全部模型, and any ID can still be typed and saved. A model the
 * relay does not list is marked 不在中轉站清單中; one without a price,
 * 費用無法預估. The WAI-ARIA combobox pattern: ↓ opens, ↑↓ move, ↩ picks,
 * esc closes, and ↩ while the IME composes only picks the candidate.
 */
export function ModelCombobox({
  id,
  label,
  hint,
  saved,
  busy,
  load,
  onSave,
  validate,
  invalidMessage,
  builtin = false,
}: {
  id: string;
  label: string;
  hint: string;
  /** The model in use. */
  saved: string;
  busy: boolean;
  load: (refresh: boolean) => Promise<AiProviderModelsResponse>;
  onSave: (model: string) => Promise<boolean>;
  validate: (model: string) => boolean;
  invalidMessage: string;
  /**
   * A built-in reference list (Gemini, Claude, GPT; QC-057): nothing to fetch
   * or refresh and every model is a chat model, so the relay controls go.
   */
  builtin?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [list, setList] = useState<ListState>({ status: 'idle' });
  const [cursor, setCursor] = useState(-1);
  /** What filters the list: what was typed since it opened, not the value it opened with. */
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const listId = useId();
  const value = draft ?? saved;

  const fetchList = (refresh: boolean) => {
    const n = ++request.current;
    setList((prev) => ({
      status: 'loading',
      previous:
        prev.status === 'ready' ? prev.data : prev.status === 'loading' ? prev.previous : null,
    }));
    load(refresh)
      .then((data) => {
        if (n === request.current) setList({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (n === request.current)
          setList({ status: 'error', problem: describeModelListError(err) });
      });
  };

  const openList = () => {
    if (open) return;
    setOpen(true);
    setQuery('');
    setCursor(-1);
    // Only now does anything go to the relay; a list already fetched is reused.
    if (list.status === 'idle' || list.status === 'error') fetchList(false);
  };
  const close = () => {
    setOpen(false);
    setCursor(-1);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && root.current?.contains(e.target) !== true) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const models =
    list.status === 'ready'
      ? list.data.models
      : list.status === 'loading'
        ? (list.previous?.models ?? [])
        : [];
  const shown = visibleModels(models, { query, showAll: showAll || builtin, current: saved });
  const known = list.status === 'ready' ? findModel(models, value) : null;
  const notInList = !builtin && list.status === 'ready' && value.trim() !== '' && known === null;
  const unpriced = known !== null && !known.priced;

  const choose = (m: AiRelayModel) => {
    setDraft(m.id);
    setInvalid(false);
    close();
    input.current?.focus();
  };

  const optionId = (i: number) => `${listId}-opt-${String(i)}`;
  const active = cursor >= 0 && cursor < shown.length ? cursor : -1;

  return (
    <form
      className="ai-set__model-form field mcombo"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const next = value.trim();
        if (!validate(next)) {
          setInvalid(true);
          return;
        }
        void onSave(next).then((ok) => {
          if (ok) setDraft(null);
        });
      }}
    >
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="ai-set__model-controls" ref={root}>
        <div className="mcombo__box">
          <input
            ref={input}
            id={id}
            className="input mcombo__input"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
            aria-describedby={`${id}-hint${invalid ? ` ${id}-error` : ''}`}
            aria-invalid={invalid}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={value}
            onChange={(e) => {
              setDraft(e.target.value);
              setQuery(e.target.value);
              setInvalid(false);
              setCursor(-1);
              // Typing filters a list already fetched; it never fetches by itself.
              if (list.status === 'ready' && !open) setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!open) {
                  openList();
                  return;
                }
                const n = shown.length;
                if (n === 0) return;
                setCursor((c) => (e.key === 'ArrowDown' ? (c + 1) % n : c <= 0 ? n - 1 : c - 1));
              } else if (e.key === 'Enter' && open && active >= 0) {
                e.preventDefault();
                const m = shown[active];
                if (m !== undefined) choose(m);
              } else if (e.key === 'Escape' && open) {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
          <button
            type="button"
            className="mcombo__toggle"
            tabIndex={-1}
            aria-label={t('modelPicker.showList')}
            aria-expanded={open}
            aria-controls={listId}
            disabled={busy}
            onClick={() => {
              if (open) close();
              else openList();
              input.current?.focus();
            }}
          >
            <Icon name="chevronDown" size={14} />
          </button>
          {open && (
            <ExitFade>
              <div className="pop mcombo__pop">
                {!builtin && (
                  <div className="mcombo__bar">
                    <label className="mcombo__all">
                      <input
                        type="checkbox"
                        checked={showAll}
                        onChange={(e) => {
                          setShowAll(e.target.checked);
                          setCursor(-1);
                        }}
                      />
                      {t('modelPicker.showAll')}
                    </label>
                    {list.status === 'ready' && (
                      <span className="faint mcombo__count">
                        {t('modelPicker.count', { shown: shown.length, total: models.length })}
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost btn--small mcombo__refresh"
                      disabled={list.status === 'loading'}
                      onClick={() => {
                        fetchList(true);
                        input.current?.focus();
                      }}
                    >
                      <Icon name="refresh" size={14} />
                      {t('modelPicker.refresh')}
                    </button>
                  </div>
                )}
                {list.status === 'error' ? (
                  <div className="mcombo__error" role="alert">
                    <span className="mcombo__error-title">
                      <Icon name="alert" size={14} />
                      {t('modelPicker.errorTitle')}
                    </span>
                    <span>{list.problem.message}</span>
                    <TechnicalDetails text={list.problem.technical} />
                    <span className="faint">{t('modelPicker.manualHint')}</span>
                  </div>
                ) : (
                  <>
                    {list.status === 'loading' && (
                      <span className="mcombo__status faint" role="status">
                        {t('modelPicker.refreshing')}
                      </span>
                    )}
                    <ul
                      id={listId}
                      className="mcombo__list"
                      role="listbox"
                      aria-label={t('modelPicker.listLabel')}
                      aria-busy={list.status === 'loading'}
                    >
                      {shown.map((m, i) => (
                        <li
                          key={m.id}
                          id={optionId(i)}
                          role="option"
                          aria-selected={i === active}
                          className="mcombo__opt"
                          onMouseDown={(e) => {
                            e.preventDefault();
                          }}
                          onMouseEnter={() => {
                            setCursor(i);
                          }}
                          onClick={() => {
                            choose(m);
                          }}
                        >
                          <span className="mono mcombo__id">{m.id}</span>
                          {m.id === saved && <Chip tone="accent">{t('modelPicker.current')}</Chip>}
                          <span className="faint mcombo__kind">{t(KIND_LABEL[m.kind])}</span>
                        </li>
                      ))}
                    </ul>
                    {list.status === 'ready' && shown.length === 0 && (
                      <span className="mcombo__status faint">
                        {models.length === 0 ? t('modelPicker.empty') : t('modelPicker.noMatch')}
                      </span>
                    )}
                  </>
                )}
                <span className="mcombo__foot faint">
                  {builtin
                    ? t('aiServices.builtinHint')
                    : list.status === 'ready'
                      ? `${t('modelPicker.fetchedAt', { when: formatWhen(list.data.fetched_at) })} · ${
                          showAll ? t('modelPicker.loadHint') : t('modelPicker.chatOnlyHint')
                        }`
                      : t('modelPicker.loadHint')}
                </span>
              </div>
            </ExitFade>
          )}
        </div>
        <button type="submit" className="btn btn--small" disabled={busy || value.trim() === saved}>
          {t('serviceSettings.aiSaveModel')}
        </button>
      </div>
      {(notInList || unpriced) && (
        <span className="mcombo__flags">
          {notInList && (
            <span className="mcombo__flag" title={t('modelPicker.notInListHint')}>
              <Chip tone="warn">{t('modelPicker.notInList')}</Chip>
              <span className="faint">{t('modelPicker.notInListHint')}</span>
            </span>
          )}
          {unpriced && (
            <span className="mcombo__flag">
              <Chip tone="warn">{t('modelPicker.unpriced')}</Chip>
              <span className="faint">{t('modelPicker.unpricedHint')}</span>
            </span>
          )}
        </span>
      )}
      <span className="ai-set__hint faint" id={`${id}-hint`}>
        {hint}
      </span>
      {invalid && (
        <span className="ln__err" id={`${id}-error`} role="alert">
          {invalidMessage}
        </span>
      )}
    </form>
  );
}
