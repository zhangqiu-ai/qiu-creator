import type { Project, ProjectRules, RulesPreviewItem, TextScript } from '@qiu-creator/contracts';
import { useEffect, useId, useState } from 'react';
import { Dialog } from './Dialog.js';
import { t } from './i18n.js';
import { Icon, type IconName } from './Icon.js';
import {
  addRuleValue,
  EMPTY_RULES,
  outcomeLabel,
  reasonsText,
  removeRuleValue,
  RULE_FIELD_LABEL,
  RULE_FIELDS,
  scoreText,
  type RuleField,
} from './project-rules-ui.js';
import type { ProjectsStore } from './projects-store.js';
import { radioKeys } from './radio-keys.js';
import {
  choiceLabel,
  choiceOf,
  PROJECT_SCRIPT_CHOICES,
  valueOf,
  type ProjectScriptChoice,
} from './text-script-ui.js';
import './agents-settings.css';

const FIELD_ICON: Readonly<Record<RuleField, IconName>> = {
  keywords: 'tag',
  tags: 'tag',
  folders: 'folder',
  domains: 'link',
};

/** The trial runs this long after the last change to the rules. */
const PREVIEW_DELAY_MS = 350;

/**
 * 項目設定 (QC-091 on the QC-092 API, PT-20261124-001): the description
 * agents read, and the rules — keywords, tags, source folders, source
 * domains — with a trial on the latest 20 works beside them (score, why,
 * and whether it would join on its own or only be suggested). QC-109 adds
 * 作品文字字體: follow the global setting, 簡體 or 繁體. Nothing is saved
 * until 儲存; the trial never saves.
 */
export function ProjectRulesDialog({
  store,
  project,
  onClose,
}: {
  store: ProjectsStore;
  project: Project;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(project.description ?? '');
  const [rules, setRules] = useState<ProjectRules>(project.rules ?? EMPTY_RULES);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RulesPreviewItem[] | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [script, setScript] = useState<ProjectScriptChoice>(choiceOf(project.text_script));
  const [globalScript, setGlobalScript] = useState<TextScript | null>(null);
  const descId = useId();
  const scriptId = useId();

  // 「跟隨全域」 names the global script once it is known.
  useEffect(() => {
    let alive = true;
    store
      .globalTextScript()
      .then((g) => {
        if (alive) setGlobalScript(g);
      })
      .catch(() => {
        // The choice still works; it just reads 「跟隨全域」 without the name.
      });
    return () => {
      alive = false;
    };
  }, [store]);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      store
        .previewRules(project.id, rules)
        .then((res) => {
          if (!alive) return;
          setPreviewFailed(false);
          setPreview(res.items);
        })
        .catch(() => {
          if (alive) setPreviewFailed(true);
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [store, project.id, rules]);

  const save = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    store
      .patch(project, {
        description: description.trim(),
        rules,
        // Sent only when changed, so an older server without the field is not asked for it.
        ...(script === choiceOf(project.text_script) ? {} : { text_script: valueOf(script) }),
      })
      .then((next) => {
        if (next === null) {
          setBusy(false);
          setError(t('agents.rulesConflict'));
          const fresh = store.find(project.id);
          if (fresh !== null) {
            setDescription(fresh.description ?? '');
            setRules(fresh.rules ?? EMPTY_RULES);
            setScript(choiceOf(fresh.text_script));
          }
          return;
        }
        onClose();
      })
      .catch(() => {
        setBusy(false);
        setError(t('agents.rulesSaveFailed'));
      });
  };

  return (
    <Dialog
      title={t('agents.projSettingsTitle', { name: project.name })}
      onClose={onClose}
      width={960}
      footer={
        <>
          <button type="button" className="btn dialog__primary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="pj-rules">
        <div className="pj-rules__form">
          <div className="field">
            <div className="pj-rules__label">
              <label htmlFor={descId} className="field__label">
                {t('agents.descLabel')}
              </label>
              <span className="faint">{t('agents.descHint')}</span>
            </div>
            <textarea
              id={descId}
              data-autofocus
              className="input pj-rules__desc"
              rows={3}
              maxLength={2000}
              placeholder={t('agents.descPlaceholder')}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </div>
          <div className="field">
            <div className="pj-rules__label">
              <span id={scriptId} className="field__label">
                {t('agents.scriptTitle')}
              </span>
            </div>
            <div
              className="seg pj-script__seg"
              role="radiogroup"
              aria-labelledby={scriptId}
              aria-describedby={`${scriptId}-note`}
            >
              {PROJECT_SCRIPT_CHOICES.map((choice, i) => {
                const checked = script === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-pressed={checked}
                    tabIndex={checked ? 0 : -1}
                    onClick={() => {
                      setScript(choice);
                    }}
                    onKeyDown={(e) => {
                      radioKeys(e, PROJECT_SCRIPT_CHOICES, i, setScript);
                    }}
                  >
                    {choiceLabel(choice, globalScript)}
                  </button>
                );
              })}
            </div>
            <p className="faint pj-script__note" id={`${scriptId}-note`}>
              {t('agents.scriptNote')}
            </p>
          </div>
          {RULE_FIELDS.map((field) => (
            <RuleList
              key={field}
              field={field}
              values={rules[field]}
              onAdd={(typed) => {
                const r = addRuleValue(rules, field, typed);
                if (r === null) return null;
                if ('error' in r) return r.error;
                setRules(r.rules);
                return null;
              }}
              onRemove={(value) => {
                setRules(removeRuleValue(rules, field, value));
              }}
            />
          ))}
          {error !== null && (
            <p className="field__error" role="alert">
              {error}
            </p>
          )}
        </div>

        <section className="pj-trial" aria-label={t('agents.previewTitle', { count: 20 })}>
          <div className="pj-trial__head">
            <b>{t('agents.previewTitle', { count: 20 })}</b>
            <span className="faint">{t('agents.previewLegend')}</span>
          </div>
          {previewFailed ? (
            <p className="faint">{t('agents.previewFailed')}</p>
          ) : preview === null ? (
            <div className="pj-trial__list" aria-busy="true" />
          ) : preview.length === 0 ? (
            <p className="faint">{t('agents.previewEmpty')}</p>
          ) : (
            <ul className="pj-trial__list">
              {preview.map((w) => (
                <li key={w.work_id} className="pj-trial__row">
                  <span className="pj-trial__main">
                    <span className="pj-trial__title">{w.title}</span>
                    <span className="faint pj-trial__why">{reasonsText(w.reasons)}</span>
                  </span>
                  <span className={`pj-trial__score pj-trial__score--${w.outcome}`}>
                    {scoreText(w.score)}
                  </span>
                  <span className={`chip pj-trial__out pj-trial__out--${w.outcome}`}>
                    {w.member && w.outcome === 'none'
                      ? t('agents.alreadyMember')
                      : outcomeLabel(w.outcome)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="faint pj-trial__note">{t('agents.previewNote')}</p>
        </section>
      </div>
    </Dialog>
  );
}

/** One rule list: values as removable chips, ＋ opens a field (Enter adds, Esc closes). */
function RuleList({
  field,
  values,
  onAdd,
  onRemove,
}: {
  field: RuleField;
  values: readonly string[];
  /** The reason it was refused, or null when added (or empty). */
  onAdd: (typed: string) => string | null;
  onRemove: (value: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const label = RULE_FIELD_LABEL[field];
  const commit = () => {
    const why = onAdd(typed);
    if (why !== null) {
      setError(why);
      return;
    }
    setTyped('');
    setError(null);
  };
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field__label">{label}</span>
      <div className="pj-chips">
        {values.map((v) => (
          <span key={v} className="ag-chip pj-chip">
            <Icon name={FIELD_ICON[field]} size={11} />
            {field === 'tags' ? `#${v}` : v}
            <button
              type="button"
              aria-label={t('agents.removeValue', { value: v })}
              onClick={() => {
                onRemove(v);
              }}
            >
              <Icon name="close" size={10} />
            </button>
          </span>
        ))}
        {adding ? (
          <input
            className="input pj-chips__input"
            // The field was opened by ＋ on purpose: the caret goes there.
            autoFocus
            aria-label={t('agents.addValue', { field: label })}
            placeholder={
              field === 'folders' ? t('agents.folderPlaceholder') : t('agents.addValueHint')
            }
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setAdding(false);
                setTyped('');
                setError(null);
              }
            }}
            onBlur={() => {
              if (typed.trim() === '') setAdding(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="pj-chips__add"
            aria-label={t('agents.addValue', { field: label })}
            onClick={() => {
              setAdding(true);
            }}
          >
            <Icon name="plus" size={12} />
          </button>
        )}
      </div>
      {error !== null && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
