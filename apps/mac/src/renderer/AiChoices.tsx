import {
  AI_PROVIDER_NAMES,
  type AiConcreteLanguage,
  type AiModelChoice,
  type AiModelsResponse,
  type AiOutputLanguage,
  type AiProvider,
  type RewriteResult,
} from '@qiu-creator/contracts';
import { detectLanguage } from '@qiu-creator/domain/search';
import type { MessageKey } from '@qiu-creator/i18n';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { currentModel, useAiLibrary, type AiLibraryState } from './ai-library.js';
import { formatWhen, t } from './i18n.js';
import { Icon } from './Icon.js';
import { Animated } from './motion.js';

/**
 * 輸出語言 and 模型 (QC-075, PT-20261122-003): the two quick switches in the
 * selection toolbar and at the top of the 改寫 panel. Both are global
 * preferences kept on the Mac; picking one saves it at once, so the toolbar,
 * the panel and other devices agree.
 */

/** Language names are written in their own language (endonyms), the same in every locale. */
const LANGUAGE_KEY: Readonly<Record<AiConcreteLanguage, { name: MessageKey; short: MessageKey }>> =
  {
    'zh-Hans': { name: 'ai.langNameHans', short: 'ai.langShortHans' },
    'zh-Hant': { name: 'ai.langNameHant', short: 'ai.langShortHant' },
    en: { name: 'ai.langNameEn', short: 'ai.langShortEn' },
  };

export function languageName(lang: AiConcreteLanguage): string {
  return t(LANGUAGE_KEY[lang].name);
}

export function languageShort(lang: AiConcreteLanguage): string {
  return t(LANGUAGE_KEY[lang].short);
}

/** The chip's text: 跟隨原文, or the language's short name. */
export function languageChip(lang: AiOutputLanguage): string {
  return lang === 'follow' ? t('ai.langFollow') : languageShort(lang);
}

/** The language a job would write in for this text (what 跟隨原文 resolves to), or null. */
export function resolvedLanguage(lang: AiOutputLanguage, text: string): AiConcreteLanguage | null {
  return lang === 'follow' ? detectLanguage(text) : lang;
}

/** Colour and two-letter mark of each provider, for the model menu and chips. */
const PROVIDER_MARK: Readonly<Record<AiProvider, { mark: string; hue: string }>> = {
  anthropic: { mark: 'Cl', hue: '#B4612F' },
  'new-api': { mark: 'NA', hue: '#6B5BB8' },
  gemini: { mark: 'Ge', hue: '#2F6FCF' },
  openai: { mark: 'GP', hue: '#3B7A5E' },
};

export function ProviderMark({ provider }: { provider: AiProvider }) {
  const p = PROVIDER_MARK[provider];
  return (
    <span className="pmark" style={{ background: p.hue }} aria-hidden="true">
      {p.mark}
    </span>
  );
}

/** 「Claude · opus-5-5」: the provider and the model without its family prefix. */
export function modelShort(choice: AiModelChoice): string {
  const name = AI_PROVIDER_NAMES[choice.provider].name;
  const model = choice.model.replace(/^(claude|gemini)-/, '');
  return `${name} · ${model}`;
}

/**
 * The model a rewrite uses now: the one remembered for rewrites, else the
 * default of the first ready provider in the list (null while unknown).
 */
export function shownModel(state: AiLibraryState): AiModelChoice | null {
  const chosen = currentModel(state, 'rewrite');
  if (chosen !== null) return chosen;
  const first = state.models?.items.find((m) => m.default);
  return first === undefined ? null : { provider: first.provider, model: first.model };
}

/** Closes on a press outside it (its trigger excluded) and on esc. */
function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (root.current?.contains(target) === true) return;
      close.current();
    };
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open, root]);
}

/** A trigger and its popover; `place` decides whether it opens above or below. */
export function ChoiceButton({
  label,
  className,
  title,
  place,
  align = 'start',
  popupWidth,
  haspopup,
  children,
  popup,
}: {
  label: string;
  className: string;
  title?: string;
  place: 'above' | 'below';
  /** Which edge of the trigger the popover lines up with (`end`: it opens towards the left). */
  align?: 'start' | 'end';
  popupWidth: number;
  haspopup: 'listbox' | 'dialog';
  children: ReactNode;
  popup: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, root, () => {
    setOpen(false);
  });
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const style: CSSProperties = {
    ...(place === 'above' ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 6px)' }),
    ...(align === 'end' ? { left: 'auto', right: 0 } : {}),
    width: popupWidth,
  };
  return (
    <span className="choice" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={label}
        title={title ?? label}
        aria-haspopup={haspopup}
        aria-expanded={open}
        onMouseDown={(e) => {
          // Keep the text selection while using the toolbar.
          e.preventDefault();
        }}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        {children}
      </button>
      {open && (
        <Animated
          preset={{
            kind: 'popover',
            origin: `${place === 'above' ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}`,
          }}
          className="qpop"
          style={style}
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          {popup(close)}
        </Animated>
      )}
    </span>
  );
}

/** ↑↓ between the enabled options of a listbox popover. */
function moveFocus(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const list = e.currentTarget;
  const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)'));
  if (options.length === 0) return;
  e.preventDefault();
  const at = options.findIndex((o) => o === document.activeElement);
  const to = at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  options[to]?.focus();
}

const LANGS: readonly AiOutputLanguage[] = ['follow', 'zh-Hans', 'zh-Hant', 'en'];

/** The 輸出語言 list: 跟隨原文 (with what the text was detected as), then the three. */
export function LanguageList({
  value,
  sample,
  onPick,
}: {
  value: AiOutputLanguage;
  /** The text the next job works on, to say what 跟隨原文 will use. */
  sample: string;
  onPick: (lang: AiOutputLanguage) => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
  }, []);
  const detected = sample.trim() === '' ? null : detectLanguage(sample);
  return (
    <div role="listbox" aria-label={t('ai.langLabel')} className="qpop__list" onKeyDown={moveFocus}>
      <span className="qpop__hd">{t('ai.langLabel')}</span>
      {LANGS.map((lang) => {
        const on = lang === value;
        return (
          <button
            key={lang}
            ref={on ? first : undefined}
            type="button"
            role="option"
            aria-selected={on}
            className={on ? 'qpop__o is-on' : 'qpop__o'}
            onClick={() => {
              onPick(lang);
            }}
          >
            <span className="qpop__ck">{on && <Icon name="check" size={14} />}</span>
            {lang === 'follow' ? t('ai.langFollow') : languageName(lang)}
            {lang === 'follow' && detected !== null && (
              <span className="qpop__d">
                {t('ai.langDetected', { lang: languageName(detected) })}
              </span>
            )}
          </button>
        );
      })}
      <span className="qpop__ft">{t('ai.langFoot')}</span>
    </div>
  );
}

/** The 模型 list: search, grouped by ready provider, the current one checked. */
export function ModelList({
  models,
  current,
  last,
  onPick,
  onOpenServices,
}: {
  models: AiModelsResponse | null;
  current: AiModelChoice | null;
  /** Marked 「上次用」. */
  last: AiModelChoice | null;
  onPick: (choice: AiModelChoice) => void;
  onOpenServices: (() => void) | null;
}) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const items = (models?.items ?? []).filter((m) => m.kind !== 'image');
  const providers = [...new Set(items.map((m) => m.provider))];
  const same = (a: AiModelChoice | null, p: AiProvider, model: string) =>
    a !== null && a.provider === p && a.model === model;
  const groups = providers
    .map((provider) => ({
      provider,
      items: items.filter(
        (m) =>
          m.provider === provider &&
          (query === '' ||
            m.model.toLowerCase().includes(query) ||
            AI_PROVIDER_NAMES[provider].name.toLowerCase().includes(query)),
      ),
    }))
    .filter((g) => g.items.length > 0);
  // QC-082: a provider whose list failed but that fell back to its cached or
  // stored models is listed as usual, with a note; one with nothing to fall
  // back on stays a disabled 「無法讀取模型」 row.
  const errors = models?.errors ?? [];
  const fallbacks = new Map(
    errors.filter((e) => e.fallback !== 'none').map((e) => [e.provider, e] as const),
  );
  const broken = errors.filter((e) => e.fallback === 'none');
  return (
    <div className="qpop__list" onKeyDown={moveFocus}>
      <label className="qpop__search">
        <Icon name="search" size={14} />
        <input
          // The search is what the menu opens for.
          autoFocus
          type="search"
          placeholder={t('ai.modelSearch')}
          aria-label={t('ai.modelSearch')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              e.currentTarget
                .closest('.qpop__list')
                ?.querySelector<HTMLElement>('[role="option"]:not(:disabled)')
                ?.focus();
            }
          }}
        />
      </label>
      <div role="listbox" aria-label={t('ai.modelLabel')} className="qpop__scroll">
        {models === null && <span className="qpop__empty">{t('common.loading')}</span>}
        {models !== null && groups.length === 0 && (
          <span className="qpop__empty">
            {items.length === 0 ? t('ai.modelNone') : t('ai.modelNoMatch')}
          </span>
        )}
        {groups.map((g) => (
          <div key={g.provider} role="group" aria-label={AI_PROVIDER_NAMES[g.provider].name}>
            <span className="qpop__hd">
              <ProviderMark provider={g.provider} />
              {AI_PROVIDER_NAMES[g.provider].name}
            </span>
            {fallbacks.has(g.provider) && <FallbackNote error={fallbacks.get(g.provider)} />}
            {g.items.map((m) => {
              const on = same(current, m.provider, m.model);
              return (
                <button
                  key={m.model}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={on ? 'qpop__o is-on' : 'qpop__o'}
                  onClick={() => {
                    onPick({ provider: m.provider, model: m.model });
                  }}
                >
                  <span className="qpop__ck">{on && <Icon name="check" size={14} />}</span>
                  <span className="qpop__name">{m.model}</span>
                  {same(last, m.provider, m.model) && (
                    <span className="qpop__d">{t('ai.modelLast')}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
        {broken.map((b) => (
          <div key={b.provider} role="group" aria-label={AI_PROVIDER_NAMES[b.provider].name}>
            <span className="qpop__hd">
              <ProviderMark provider={b.provider} />
              {AI_PROVIDER_NAMES[b.provider].name}
              <span className="qpop__bad">{t('ai.modelUnavailable')}</span>
            </span>
          </div>
        ))}
      </div>
      <span className="qpop__ft">
        <span>{t('ai.modelFoot')}</span>
        {onOpenServices !== null && (
          <button type="button" className="qpop__link" onClick={onOpenServices}>
            {t('ai.modelServices')} ›
          </button>
        )}
      </span>
    </div>
  );
}

/** Reasons the service gives for a failed model list (QC-082); others are shown as sent. */
const REASON_KEY: Readonly<Record<string, MessageKey>> = {
  timeout: 'ai.modelReasonTimeout',
  dns: 'ai.modelReasonDns',
  unavailable: 'ai.modelReasonUnavailable',
  quota: 'ai.modelReasonQuota',
};

/** The reason and, for a cached list, when it was read: 「逾時 · 清單快取於 3 分鐘前」. */
export function fallbackDetail(
  error: Pick<AiModelsResponse['errors'][number], 'reason' | 'fallback' | 'cached_at'>,
  now: Date = new Date(),
): string {
  const parts: string[] = [];
  if (error.reason !== null) {
    const key = REASON_KEY[error.reason];
    parts.push(key === undefined ? error.reason : t(key));
  }
  if (error.fallback === 'cache' && error.cached_at !== null)
    parts.push(t('ai.modelCachedAt', { when: formatWhen(error.cached_at, now) }));
  return parts.join(' · ');
}

/** 「清單讀取失敗，使用已存模型」 under a provider whose list could not be read. */
function FallbackNote({ error }: { error: AiModelsResponse['errors'][number] | undefined }) {
  if (error === undefined) return null;
  const detail = fallbackDetail(error);
  return (
    <span className="qpop__note" role="note">
      <Icon name="alert" size={12} />
      <span>
        {t('ai.modelFallback')}
        {detail !== '' && <span className="qpop__note-d">{detail}</span>}
      </span>
    </span>
  );
}

/**
 * The language and model switches, as toolbar chips (`compact`) or as the two
 * selects at the top of the 改寫 panel. Both save at once and say so.
 */
export function LanguageModelSwitch({
  variant,
  sample,
  onError,
  onOpenServices,
}: {
  variant: 'toolbar' | 'panel';
  sample: string;
  onError: (text: string) => void;
  onOpenServices: (() => void) | null;
}) {
  const { library, state } = useAiLibrary();
  const lang = state.preferences?.output_language ?? 'follow';
  const model = shownModel(state);
  const last = currentModel(state, 'rewrite');
  const place = variant === 'toolbar' ? 'above' : 'below';
  const detected = lang === 'follow' && sample.trim() !== '' ? detectLanguage(sample) : null;
  // The model list is only asked for when a menu could show it.
  useEffect(() => {
    void library?.loadModels();
  }, [library]);
  if (library === null) return null;
  const pickLang = (next: AiOutputLanguage, close: () => void) => {
    close();
    void library.setLanguage(next).catch(() => {
      onError(t('ai.prefsFailed'));
    });
  };
  const pickModel = (next: AiModelChoice, close: () => void) => {
    close();
    void library.setModel('rewrite', next).catch(() => {
      onError(t('ai.prefsFailed'));
    });
  };
  const langText =
    variant === 'toolbar'
      ? languageChip(lang)
      : lang === 'follow'
        ? detected === null
          ? t('ai.langFollow')
          : `${t('ai.langFollow')} · ${languageName(detected)}`
        : languageName(lang);
  const cls = variant === 'toolbar' ? 'tchip' : 'chipsel';
  return (
    <>
      <ChoiceButton
        label={t('ai.langLabel')}
        className={cls}
        place={place}
        popupWidth={240}
        haspopup="listbox"
        popup={(close) => (
          <LanguageList
            value={lang}
            sample={sample}
            onPick={(next) => {
              pickLang(next, close);
            }}
          />
        )}
      >
        <Icon name="language" size={14} />
        <span className="chipsel__v">{langText}</span>
      </ChoiceButton>
      <ChoiceButton
        label={t('ai.modelLabel')}
        className={cls}
        place={place}
        // In the panel the model is the right-hand select: its menu opens towards the left.
        align={variant === 'panel' ? 'end' : 'start'}
        popupWidth={280}
        haspopup="listbox"
        popup={(close) => (
          <ModelList
            models={state.models}
            current={model}
            last={last}
            onPick={(next) => {
              pickModel(next, close);
            }}
            onOpenServices={
              onOpenServices === null
                ? null
                : () => {
                    close();
                    onOpenServices();
                  }
            }
          />
        )}
      >
        {model === null ? (
          <span className="chipsel__v">{t('ai.modelLabel')}</span>
        ) : (
          <>
            <ProviderMark provider={model.provider} />
            <span className="chipsel__v">{modelShort(model)}</span>
          </>
        )}
      </ChoiceButton>
    </>
  );
}

/**
 * What a candidate says about how it was written (QC-075): its language (and
 * 跟隨原文 when it was detected), its model, and 「prompt 指定」 when the
 * prompt chose either.
 */
export function CandidateTags({
  result,
  model,
}: {
  result: Pick<RewriteResult, 'language' | 'language_source' | 'model_source'>;
  model: AiModelChoice;
}) {
  const fromPrompt = result.language_source === 'prompt' || result.model_source === 'prompt';
  return (
    <>
      {result.language !== undefined && (
        <span className="langtag" title={t('ai.langLabel')}>
          {languageShort(result.language)}
          {result.language_source === 'detected' && `（${t('ai.langFollow')}）`}
        </span>
      )}
      <span className="langtag" title={t('ai.modelLabel')}>
        {modelShort(model)}
      </span>
      {fromPrompt && <span className="langtag langtag--accent">{t('ai.fromPrompt')}</span>}
    </>
  );
}
