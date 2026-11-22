import { closestCenter, DndContext, type Announcements, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ApiError, promptSuggestionOf, type CreatorHubClient } from '@qiu-creator/api-client';
import {
  PROMPT_CONTENT_MAX,
  PROMPT_NAME_MAX,
  type AiJobRecord,
  type AiOutputLanguage,
  type Prompt,
  type PromptScene,
  type PromptSuggestionResult,
} from '@qiu-creator/contracts';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEventHandler,
  type ReactNode,
  type RefObject,
} from 'react';
import { languageName, modelShort } from './AiChoices.js';
import { currentModel, useAiLibrary } from './ai-library.js';
import { AiProviders, JobWatch, messageOf, type AiBlock } from './ai-session.js';
import { anchorOf, ContextMenu, type MenuAnchor, type MenuEntry } from './ContextMenu.js';
import { Dialog } from './Dialog.js';
import { useChangeEvents } from './events.js';
import { formatWhen, t } from './i18n.js';
import { Icon } from './Icon.js';
import { sortTransition, useDragSensors } from './dnd-motion.js';
import { useMotionMode } from './motion-mode.js';
import { useNotice } from './project-actions.js';
import { Highlighted, SCENE_ICON, SCENE_LABEL } from './PromptPicker.js';
import {
  afterRemoval,
  changeCount,
  customIds,
  draftChanged,
  draftOf,
  dropCustom,
  emptyDraft,
  exportFileName,
  firstSelection,
  groupNames,
  groupPrompts,
  insertVariable,
  modelFromKey,
  modelKey,
  moveCustom,
  parseImport,
  previewLine,
  sameDraft,
  savable,
  splitVariables,
  VARIABLE_CHIPS,
  type PromptDraft,
} from './prompts-page.js';
import { diffSentences, type Segment } from './rewrite-diff.js';
import './prompts.css';

/**
 * Prompt 庫 (QC-075, approved prototype PT-20261122-003): the prompts the
 * toolbar and the AI panel offer. Built-ins are read-only and can be copied;
 * custom prompts are edited here, dragged into order, exported and imported,
 * and AI can draft or rewrite one — always as a candidate with a diff, kept
 * only on 保留 (DESIGN.md 互動合約: AI never overwrites what the user wrote).
 */

/** How long after the last keystroke a change is saved. */
const SAVE_AFTER_MS = 600;
/** How often a running suggestion is asked about when no SSE nudge arrives. */
const POLL_MS = 3000;
/** How long an exported file's blob URL is kept, so the download can read it. */
const REVOKE_AFTER_MS = 60_000;

const SCENES: readonly PromptScene[] = ['selection', 'full', 'title', 'image'];
const LANGUAGES: readonly AiOutputLanguage[] = ['follow', 'zh-Hans', 'zh-Hant', 'en'];

/** The built-ins' padlock; drawn here in the shared icon style (24×24, 1.8 stroke). */
function LockMark() {
  return (
    <svg
      className="icon pl__lock"
      width={13}
      height={13}
      viewBox="0 0 24 24"
      role="img"
      aria-label={t('prompts.builtin')}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** What the editor is showing: a saved prompt, or a new one not yet created. */
type Selection = { kind: 'prompt'; id: string } | { kind: 'draft' } | null;

/** An AI candidate waiting to be kept, with the job it came from. */
interface Candidate {
  result: PromptSuggestionResult;
  /** The content it was written against, for the diff. */
  original: string;
}

export function PromptsPage({
  client,
  onOpenAiServices,
}: {
  client: CreatorHubClient | null;
  onOpenAiServices: () => void;
}) {
  const { library, state } = useAiLibrary();
  const notify = useNotice();
  const prompts = state.prompts ?? [];
  const builtins = prompts.filter((p) => p.builtin);
  const customs = prompts.filter((p) => !p.builtin);

  const [selection, setSelection] = useState<Selection>(null);
  const [draft, setDraft] = useState<PromptDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Prompt | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState('');
  const [closed, setClosed] = useState<readonly string[]>([]);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [confirming, setConfirming] = useState<Prompt | null>(null);
  const [description, setDescription] = useState('');
  const [running, setRunning] = useState(false);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [block, setBlock] = useState<AiBlock | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const started = useRef(false);

  const base = useMemo(
    () =>
      selection?.kind === 'prompt' ? (prompts.find((p) => p.id === selection.id) ?? null) : null,
    [prompts, selection],
  );
  const editing = selection?.kind === 'draft' || (base !== null && !base.builtin);
  const dirty =
    base === null ? selection?.kind === 'draft' && savable(draft) : draftChanged(draft, base);

  useEffect(() => {
    void library?.loadModels();
  }, [library]);

  // The page opens on the first custom prompt; with none, on the empty state.
  useEffect(() => {
    if (started.current || state.prompts === null) return;
    started.current = true;
    const first = firstSelection(state.prompts);
    if (first !== null) {
      setSelection({ kind: 'prompt', id: first });
      const found = state.prompts.find((p) => p.id === first);
      if (found !== undefined) setDraft(draftOf(found));
    }
  }, [state.prompts]);

  const open = useCallback((prompt: Prompt) => {
    setSelection({ kind: 'prompt', id: prompt.id });
    setDraft(draftOf(prompt));
    setSaving(false);
    setFailed(false);
    setConflict(null);
    setCandidate(null);
    setDescription('');
  }, []);

  const newPrompt = useCallback(() => {
    setSelection({ kind: 'draft' });
    setDraft(emptyDraft());
    setSaving(false);
    setFailed(false);
    setConflict(null);
    setCandidate(null);
    setDescription('');
  }, []);

  const edit = useCallback((patch: Partial<PromptDraft>) => {
    setFailed(false);
    setDraft((old) => ({ ...old, ...patch }));
  }, []);

  // ---- Saving ------------------------------------------------------------------------------

  const save = useCallback(
    async (over?: Prompt): Promise<Prompt | null> => {
      if (client === null || library === null) return null;
      const against = over ?? base;
      if (!savable(draft)) return null;
      const sent = draft;
      setSaving(true);
      try {
        const body = {
          name: draft.name,
          content: draft.content,
          scene: draft.scene,
          group: draft.group.trim() === '' ? null : draft.group.trim(),
          model: draft.model,
          language: draft.language,
        };
        const saved =
          against === null
            ? await library.createPrompt(body)
            : await client.ai.prompts.patch(against.id, {
                ...body,
                base_revision: against.revision,
              });
        if (against !== null) await library.loadPrompts();
        // Anything typed while the save was in flight stays; it is saved next.
        setDraft((current) => (sameDraft(current, sent) ? draftOf(saved) : current));
        setSelection({ kind: 'prompt', id: saved.id });
        setConflict(null);
        setFailed(false);
        return saved;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Changed elsewhere (DESIGN.md 儲存衝突): nothing is overwritten and the
          // text stays in the field; the user picks which version to keep.
          await library.loadPrompts();
          const fresh = await client.ai.prompts.list().then(
            (r) => r.items.find((p) => p.id === against?.id) ?? null,
            () => null,
          );
          setConflict(fresh);
        } else {
          setFailed(true);
          notify({ message: messageOf(err), tone: 'bad' });
        }
        return null;
      } finally {
        setSaving(false);
      }
    },
    [base, client, draft, library, notify],
  );

  // Autosave: a short while after the last keystroke, never while a conflict waits.
  useEffect(() => {
    if (!editing || !dirty || saving || conflict !== null || failed) return;
    if (!savable(draft)) return;
    const timer = setTimeout(() => {
      void save();
    }, SAVE_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [conflict, dirty, draft, editing, failed, save, saving]);

  const saveChip = (): { label: string; tone: string } | null => {
    if (candidate !== null) return { label: t('prompts.unkept'), tone: 'chip--warn' };
    if (conflict !== null) return { label: t('prompts.conflict'), tone: 'chip--warn' };
    if (failed) return { label: t('prompts.saveFailed'), tone: 'chip--bad' };
    if (saving) return { label: t('prompts.saving'), tone: '' };
    if (dirty) return { label: t('prompts.unsaved'), tone: '' };
    if (base !== null) return { label: t('prompts.saved'), tone: 'chip--ok' };
    return null;
  };

  // ---- List actions ------------------------------------------------------------------------

  const reorder = async (ids: readonly string[]): Promise<void> => {
    if (client === null || library === null) return;
    try {
      await client.ai.prompts.reorder([...ids]);
      await library.loadPrompts();
    } catch (err) {
      notify({ message: messageOf(err), tone: 'bad' });
    }
  };

  const duplicate = async (prompt: Prompt): Promise<void> => {
    if (client === null || library === null) return;
    try {
      const copy = await client.ai.prompts.duplicate(prompt.id);
      await library.loadPrompts();
      open(copy);
      notify({ message: t('prompts.duplicated') });
    } catch (err) {
      notify({ message: messageOf(err), tone: 'bad' });
    }
  };

  const remove = async (prompt: Prompt): Promise<void> => {
    if (client === null || library === null) return;
    const next = afterRemoval(prompts, prompt.id);
    try {
      await client.ai.prompts.remove(prompt.id);
      await library.loadPrompts();
      const list = (await client.ai.prompts.list()).items;
      const pick = next === null ? null : (list.find((p) => p.id === next) ?? null);
      if (pick === null) {
        setSelection(null);
        setDraft(emptyDraft());
      } else open(pick);
      notify({ message: t('prompts.deleted', { name: prompt.name }) });
    } catch (err) {
      notify({ message: messageOf(err), tone: 'bad' });
    }
  };

  // ---- Export and import -------------------------------------------------------------------

  const exportAll = async (): Promise<void> => {
    if (client === null) return;
    try {
      const file = await client.ai.prompts.exportAll();
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(new Date());
      link.click();
      // The download reads the blob after the click returns, so it is let go of later.
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, REVOKE_AFTER_MS);
      notify({ message: t('prompts.exported', { count: file.prompts.length }) });
    } catch (err) {
      notify({ message: messageOf(err), tone: 'bad' });
    }
  };

  const importFile = async (file: File): Promise<void> => {
    if (client === null || library === null) return;
    const parsed = parseImport(await file.text());
    if (parsed === null) {
      notify({ message: t('prompts.importFailed'), tone: 'bad' });
      return;
    }
    try {
      const result = await client.ai.prompts.import(parsed);
      await library.loadPrompts();
      const first = result.items[0];
      if (first !== undefined) open(first);
      notify({
        message:
          result.renamed === 0
            ? t('prompts.imported', { count: result.imported })
            : t('prompts.importedRenamed', { count: result.imported, renamed: result.renamed }),
      });
    } catch (err) {
      notify({ message: messageOf(err), tone: 'bad' });
    }
  };

  // ---- AI suggestion -----------------------------------------------------------------------

  const providers = useMemo(() => (client === null ? null : new AiProviders(client)), [client]);
  const watch = useRef<JobWatch | null>(null);
  useEffect(
    () => () => {
      watch.current?.stop();
      watch.current = null;
    },
    [],
  );
  useChangeEvents((event) => {
    if (event.entity !== 'job' || !event.action.startsWith('ai_job.')) return;
    if (watch.current?.id === event.entity_id) void watch.current.check();
  });

  const onJob = useCallback(
    (job: AiJobRecord, original: string): void => {
      if (job.status === 'queued' || job.status === 'running') return;
      setRunning(false);
      if (job.status === 'cancelled') return;
      const result = job.status === 'succeeded' ? promptSuggestionOf(job) : null;
      if (result === null) {
        notify({ message: t('ai.generateFailed'), tone: 'bad' });
        return;
      }
      setCandidate({ result, original });
    },
    [notify],
  );

  const suggest = async (): Promise<void> => {
    if (client === null || providers === null || description.trim() === '') return;
    setCandidate(null);
    setBlock(null);
    setRunning(true);
    // The AI reads the saved prompt, so anything typed is saved first.
    let against = base;
    if (dirty && savable(draft)) {
      against = await save();
      if (against === null) {
        setRunning(false);
        return;
      }
    }
    const remembered = currentModel(state, 'prompt');
    let picked: Awaited<ReturnType<AiProviders['pick']>>;
    try {
      picked = await providers.pick(remembered?.provider ?? null);
    } catch (err) {
      setRunning(false);
      notify({ message: messageOf(err), tone: 'bad' });
      return;
    }
    if (picked.provider === null) {
      setRunning(false);
      setBlock(picked.block);
      return;
    }
    const provider = picked.provider.provider;
    const model = remembered?.provider === provider ? remembered.model : undefined;
    const original = against?.content ?? '';
    try {
      const { job } = await client.ai.prompts.suggest({
        provider,
        ...(model === undefined ? {} : { model }),
        description: description.trim(),
        ...(against === null ? { scene: draft.scene } : { base_prompt_id: against.id }),
      });
      watch.current?.stop();
      watch.current = new JobWatch(
        client,
        job.id,
        (record) => {
          onJob(record, original);
        },
        POLL_MS,
      );
    } catch (err) {
      setRunning(false);
      notify({ message: messageOf(err), tone: 'bad' });
    }
  };

  const keepCandidate = async (): Promise<void> => {
    if (candidate === null || client === null || library === null) return;
    const result = candidate.result;
    const next: PromptDraft = {
      ...draft,
      name: draft.name.trim() === '' ? result.candidate.name : draft.name,
      content: result.candidate.content,
      scene: result.candidate.scene,
    };
    setCandidate(null);
    setDraft(next);
    if (base === null) {
      setSaving(true);
      try {
        const created = await library.createPrompt({
          name: next.name,
          content: next.content,
          scene: next.scene,
          group: next.group.trim() === '' ? null : next.group.trim(),
          model: next.model,
          language: next.language,
        });
        setDraft(draftOf(created));
        setSelection({ kind: 'prompt', id: created.id });
        notify({ message: t('prompts.kept') });
      } catch (err) {
        setFailed(true);
        notify({ message: messageOf(err), tone: 'bad' });
      } finally {
        setSaving(false);
      }
      return;
    }
    setSaving(true);
    try {
      const saved = await client.ai.prompts.patch(base.id, {
        base_revision: result.base_revision ?? base.revision,
        name: next.name,
        content: next.content,
        scene: next.scene,
      });
      await library.loadPrompts();
      setDraft(draftOf(saved));
      notify({ message: t('prompts.kept') });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await library.loadPrompts();
        const fresh = await client.ai.prompts.list().then(
          (r) => r.items.find((p) => p.id === base.id) ?? null,
          () => null,
        );
        setConflict(fresh);
      } else {
        setFailed(true);
        notify({ message: messageOf(err), tone: 'bad' });
      }
    } finally {
      setSaving(false);
    }
  };

  // ⌘↩ keeps the candidate, esc discards it (not while typing in a field or a dialog).
  useEffect(() => {
    if (candidate === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], [role="alertdialog"]') != null) return;
      if (e.key === 'Enter' && e.metaKey) {
        e.preventDefault();
        void keepCandidate();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setCandidate(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  });

  // ---- List ---------------------------------------------------------------------------------

  const groups = groupPrompts(prompts, hits, {
    builtin: t('prompts.builtin'),
    ungrouped: t('prompts.ungrouped'),
  });
  const ids = customIds(prompts);
  const sortableIds = groups.flatMap((g) =>
    g.builtin || closed.includes(g.key) ? [] : g.items.map((p) => p.id),
  );
  const sensors = useDragSensors();
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('prompts.dndPicked', { name: nameOf(prompts, active.id) }),
    onDragOver: ({ active, over }) =>
      over === null
        ? t('prompts.dndPicked', { name: nameOf(prompts, active.id) })
        : t('prompts.dndPosition', {
            name: nameOf(prompts, active.id),
            position: ids.indexOf(String(over.id)) + 1,
            total: ids.length,
          }),
    onDragEnd: ({ active }) => t('prompts.dndDropped', { name: nameOf(prompts, active.id) }),
    onDragCancel: ({ active }) => t('prompts.dndCancelled', { name: nameOf(prompts, active.id) }),
  };

  const onRowKey = (e: ReactKeyboardEvent<HTMLButtonElement>, prompt: Prompt): void => {
    if (e.nativeEvent.isComposing || prompt.builtin) return;
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const order = moveCustom(prompts, prompt.id, e.key === 'ArrowUp' ? -1 : 1);
    if (order.join() === ids.join()) return;
    void reorder(order).then(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-prompt-row="${prompt.id}"]`)?.focus();
      });
    });
  };

  const row = (prompt: Prompt, drag: RowDrag | null): ReactNode => (
    <button
      ref={drag?.ref}
      type="button"
      data-prompt-row={prompt.id}
      className={[
        'pl__row',
        drag?.dragging === true ? 'pl__row--dragging' : '',
        !prompt.builtin ? 'pl__row--sortable' : '',
      ]
        .filter((c) => c !== '')
        .join(' ')}
      style={drag?.style}
      aria-current={selection?.kind === 'prompt' && selection.id === prompt.id}
      {...(prompt.builtin ? {} : { 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown' })}
      onPointerDown={drag?.onPointerDown}
      onKeyDown={(e) => {
        onRowKey(e, prompt);
      }}
      onClick={() => {
        open(prompt);
      }}
    >
      <span className="pl__icon">
        <Icon name={SCENE_ICON[prompt.scene]} size={14} />
      </span>
      <span className="pl__tx">
        <b>
          <Highlighted text={prompt.name} query={hits} />
        </b>
        <span>
          <Highlighted text={previewLine(prompt.content)} query={hits} />
        </span>
      </span>
      {prompt.builtin && <LockMark />}
    </button>
  );

  const list = (
    <section className="pl__list" aria-label={t('prompts.listLabel')}>
      <div className="pl__top">
        <label className="search">
          <Icon name="search" />
          <span className="visually-hidden">{t('prompts.search')}</span>
          <input
            type="search"
            placeholder={t('prompts.search')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!(e.nativeEvent as InputEvent).isComposing) setHits(e.target.value);
            }}
            onCompositionEnd={(e) => {
              setHits(e.currentTarget.value);
            }}
          />
        </label>
      </div>
      <div className="pl__scroll">
        {groups.map((group) => {
          const shut = closed.includes(group.key);
          return (
            <div key={group.key}>
              <div className="pl__group">
                <button
                  type="button"
                  aria-expanded={!shut}
                  aria-label={t('prompts.groupToggle', { name: group.name })}
                  onClick={() => {
                    setClosed((old) =>
                      old.includes(group.key)
                        ? old.filter((k) => k !== group.key)
                        : [...old, group.key],
                    );
                  }}
                >
                  <Icon name={shut ? 'chevronRight' : 'chevronDown'} size={12} />
                  {group.name}
                </button>
                <span className="pl__group-n">{group.items.length}</span>
              </div>
              {!shut && (
                <ul className="pl__items">
                  {group.items.map((prompt) => (
                    <li key={prompt.id}>
                      {prompt.builtin ? (
                        row(prompt, null)
                      ) : (
                        <SortableRow id={prompt.id}>{(drag) => row(prompt, drag)}</SortableRow>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <div className="pl__none">
            {t('prompts.noHits', { q: hits.trim() })}
            <div className="pl__empty-acts">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  setQuery('');
                  setHits('');
                }}
              >
                {t('prompts.clearSearch')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );

  const chip = saveChip();

  return (
    <main className="page page--prompts" aria-label={t('prompts.title')}>
      <header className="page__header">
        <h1 className="page__title" tabIndex={-1}>
          {t('prompts.title')}
        </h1>
        <span className="page__count">
          {t('prompts.counts', { builtin: builtins.length, custom: customs.length })}
        </span>
        <div className="page__tools">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label={t('prompts.moreActions')}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => {
              setMenu(menu === null ? anchorOf(e) : null);
            }}
          >
            <Icon name="more" />
          </button>
          <button type="button" className="btn btn--primary" onClick={newPrompt}>
            <Icon name="plus" />
            {t('prompts.newPrompt')}
          </button>
        </div>
      </header>

      <div className="pl">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{
            restoreFocus: true,
            announcements,
            screenReaderInstructions: { draggable: t('prompts.dndInstructions') },
          }}
          onDragEnd={(e: DragEndEvent) => {
            if (e.over === null) return;
            const order = dropCustom(prompts, String(e.active.id), String(e.over.id));
            if (order !== null) void reorder(order);
          }}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {list}
          </SortableContext>
        </DndContext>

        <section className="pl__editor" aria-label={t('prompts.editorLabel')}>
          {state.prompts === null ? null : selection === null ||
            (base === null && selection.kind === 'prompt') ? (
            <div className="pl__empty">
              <Icon name="prompt" size={30} />
              <span className="pl__empty-t">{t('prompts.emptyTitle')}</span>
              <div className="pl__empty-acts">
                <button type="button" className="btn btn--primary" onClick={newPrompt}>
                  {t('prompts.newPrompt')}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    newPrompt();
                    requestAnimationFrame(() => {
                      document
                        .querySelector<HTMLInputElement>('[data-prompt-description]')
                        ?.focus();
                    });
                  }}
                >
                  <Icon name="spark" size={14} />
                  {t('prompts.genWithAi')}
                </button>
              </div>
            </div>
          ) : (
            <div className="pl__in">
              <div className="pl__head">
                <input
                  className="pl__name"
                  value={draft.name}
                  maxLength={PROMPT_NAME_MAX}
                  readOnly={!editing}
                  aria-label={t('prompts.name')}
                  placeholder={t('prompts.namePlaceholder')}
                  onChange={(e) => {
                    edit({ name: e.target.value });
                  }}
                />
                {base?.builtin === true && (
                  <>
                    <span className="chip">{t('prompts.builtin')}</span>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => {
                        void duplicate(base);
                      }}
                    >
                      <Icon name="copy" size={14} />
                      {t('prompts.duplicate')}
                    </button>
                  </>
                )}
                {editing && chip !== null && (
                  <span className={`chip ${chip.tone}`} role="status">
                    {chip.label}
                  </span>
                )}
                {base !== null && !base.builtin && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--small"
                    aria-label={t('common.delete')}
                    onClick={() => {
                      setConfirming(base);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>

              {conflict !== null && (
                <div className="pl__conflict" role="alert">
                  <Icon name="alert" size={14} />
                  <span>{t('prompts.conflict')}</span>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => {
                      const theirs = conflict;
                      setConflict(null);
                      setDraft(draftOf(theirs));
                      setSelection({ kind: 'prompt', id: theirs.id });
                    }}
                  >
                    {t('prompts.conflictTheirs')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => {
                      const theirs = conflict;
                      setConflict(null);
                      void save(theirs);
                    }}
                  >
                    {t('prompts.conflictMine')}
                  </button>
                </div>
              )}

              {editing && (
                <div className="pl__sug" aria-label={t('prompts.aiSuggest')}>
                  <div className="pl__sug-head">
                    <Icon name="spark" size={14} />
                    {base === null ? t('prompts.describeNew') : t('prompts.describeEdit')}
                  </div>
                  {block === null ? (
                    <div className="pl__sug-row">
                      <input
                        className="pl__text"
                        data-prompt-description=""
                        value={description}
                        aria-label={
                          base === null ? t('prompts.describeNew') : t('prompts.describeEdit')
                        }
                        placeholder={
                          base === null
                            ? t('prompts.describeHintNew')
                            : t('prompts.describeHintEdit')
                        }
                        onChange={(e) => {
                          setDescription(e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void suggest();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={running || description.trim() === ''}
                        onClick={() => {
                          void suggest();
                        }}
                      >
                        {running && <span className="spin" aria-hidden="true" />}
                        {running
                          ? t('prompts.generating')
                          : base === null
                            ? t('prompts.generate')
                            : t('prompts.rewrite')}
                      </button>
                    </div>
                  ) : (
                    <div className="pl__sug-row">
                      <span className="muted">{t('prompts.aiNoService')}</span>
                      <button type="button" className="btn btn--small" onClick={onOpenAiServices}>
                        {t('prompts.openAiServices')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="pl__field">
                <span className="pl__label">
                  {t('prompts.content')}
                  <span className="pl__vars">
                    {VARIABLE_CHIPS.map((chipDef) => (
                      <button
                        key={chipDef.token}
                        type="button"
                        className="pl__var"
                        disabled={!editing || candidate !== null}
                        title={t(VARIABLE_HINT[chipDef.variable])}
                        aria-label={t('prompts.insertVariable', { name: chipDef.token })}
                        onClick={() => {
                          const field = contentRef.current;
                          const at = field?.selectionStart ?? draft.content.length;
                          const to = field?.selectionEnd ?? at;
                          const next = insertVariable(draft.content, at, to, chipDef.token);
                          edit({ content: next.content });
                          // The caret is put back in the same commit as the text, so
                          // typing straight after a chip lands after it.
                          setCaret(next.caret);
                        }}
                      >
                        {chipDef.token}
                      </button>
                    ))}
                  </span>
                </span>
                {candidate !== null ? (
                  <CandidateView
                    candidate={candidate}
                    onRetry={() => {
                      void suggest();
                    }}
                    onDiscard={() => {
                      setCandidate(null);
                    }}
                    onKeep={() => {
                      void keepCandidate();
                    }}
                  />
                ) : (
                  <ContentField
                    ref={contentRef}
                    value={draft.content}
                    readOnly={!editing}
                    caret={caret}
                    onCaretApplied={() => {
                      setCaret(null);
                    }}
                    onChange={(content) => {
                      edit({ content });
                    }}
                  />
                )}
              </div>

              <div className="pl__field">
                <span className="pl__label">{t('prompts.scene')}</span>
                <div className="seg" role="group" aria-label={t('prompts.scene')}>
                  {SCENES.map((scene) => (
                    <button
                      key={scene}
                      type="button"
                      aria-pressed={draft.scene === scene}
                      disabled={!editing}
                      onClick={() => {
                        edit({ scene });
                      }}
                    >
                      <Icon name={SCENE_ICON[scene]} size={14} />
                      {t(SCENE_LABEL[scene])}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pl__row2">
                <div className="pl__field">
                  <label className="pl__label" htmlFor="pl-model">
                    {t('prompts.model')}
                  </label>
                  <select
                    id="pl-model"
                    className="pl__select"
                    disabled={!editing}
                    value={modelKey(draft.model)}
                    onChange={(e) => {
                      edit({ model: modelFromKey(e.target.value) });
                    }}
                  >
                    <option value="">{t('prompts.modelToolbar')}</option>
                    {(state.models?.items ?? [])
                      .filter((m) => m.kind !== 'image')
                      .map((m) => (
                        <option
                          key={modelKey({ provider: m.provider, model: m.model })}
                          value={modelKey({ provider: m.provider, model: m.model })}
                        >
                          {modelShort({ provider: m.provider, model: m.model })}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="pl__field">
                  <label className="pl__label" htmlFor="pl-lang">
                    {t('ai.langLabel')}
                  </label>
                  <select
                    id="pl-lang"
                    className="pl__select"
                    disabled={!editing}
                    value={draft.language ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      edit({
                        language: LANGUAGES.find((l) => l === value) ?? null,
                      });
                    }}
                  >
                    <option value="">{t('prompts.languageGlobal')}</option>
                    {LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>
                        {lang === 'follow' ? t('ai.langFollow') : languageName(lang)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="pl__row2">
                <div className="pl__field">
                  <label className="pl__label" htmlFor="pl-group">
                    {t('prompts.group')}
                  </label>
                  <input
                    id="pl-group"
                    className="pl__text"
                    list="pl-groups"
                    value={draft.group}
                    readOnly={!editing}
                    placeholder={t('prompts.groupPlaceholder')}
                    onChange={(e) => {
                      edit({ group: e.target.value });
                    }}
                  />
                  <datalist id="pl-groups">
                    {groupNames(prompts).map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </div>
                <div className="pl__field">
                  <span className="pl__label">{t('prompts.used')}</span>
                  <span className="pl__used">
                    {base === null || base.use_count === 0
                      ? t('prompts.usedNever')
                      : base.last_used_at === null
                        ? t('prompts.usedTimes', { count: base.use_count })
                        : t('prompts.usedWhen', {
                            count: base.use_count,
                            when: formatWhen(base.last_used_at),
                          })}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {menu !== null && (
        <ContextMenu
          anchor={menu}
          label={t('prompts.moreActions')}
          items={menuItems(
            () => {
              void exportAll();
            },
            () => {
              fileInput.current?.click();
            },
            customs.length,
          )}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file !== undefined) void importFile(file);
        }}
      />
      {confirming !== null && (
        <Dialog
          title={t('prompts.deleteTitle', { name: confirming.name })}
          onClose={() => {
            setConfirming(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn"
                data-autofocus=""
                onClick={() => {
                  setConfirming(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--danger-solid"
                onClick={() => {
                  const target = confirming;
                  setConfirming(null);
                  void remove(target);
                }}
              >
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p className="muted">{t('prompts.deleteBody')}</p>
        </Dialog>
      )}
    </main>
  );
}

/** Hints on the variable chips, in the order the prompts catalog lists them. */
const VARIABLE_HINT = {
  selection: 'prompts.varSelection',
  title: 'prompts.varTitle',
  text: 'prompts.varText',
  platform: 'prompts.varPlatform',
  language: 'prompts.varLanguage',
} as const;

function nameOf(prompts: readonly Prompt[], id: string | number): string {
  return prompts.find((p) => p.id === String(id))?.name ?? '';
}

function menuItems(
  onExport: () => void,
  onImport: () => void,
  customs: number,
): readonly MenuEntry[] {
  return [
    {
      kind: 'item',
      id: 'export',
      label: t('prompts.exportAll'),
      hint: 'JSON',
      disabled: customs === 0,
      onSelect: onExport,
    },
    { kind: 'item', id: 'import', label: t('prompts.importJson'), onSelect: onImport },
  ];
}

interface RowDrag {
  ref: (node: HTMLElement | null) => void;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
  style: { transform: string | undefined; transition: string | undefined };
  dragging: boolean;
}

const NO_HANDLER = (): void => undefined;

/** A custom prompt's row: drag it to a new place in the library (dnd-kit). */
function SortableRow({ id, children }: { id: string; children: (drag: RowDrag) => ReactNode }) {
  const mode = useMotionMode();
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id,
    transition: sortTransition(mode),
  });
  return children({
    ref: setNodeRef,
    onPointerDown:
      (listeners?.['onPointerDown'] as PointerEventHandler<HTMLButtonElement> | undefined) ??
      NO_HANDLER,
    style: { transform: CSS.Translate.toString(transform), transition },
    dragging: isDragging,
  });
}

/**
 * The content field: a textarea the person types in, over a backdrop that
 * draws the variables' blue blocks. The text itself always comes from the
 * textarea, so an input method's composition stays visible while typing.
 */
function ContentField({
  ref,
  value,
  readOnly,
  caret,
  onCaretApplied,
  onChange,
}: {
  ref: RefObject<HTMLTextAreaElement | null>;
  value: string;
  readOnly: boolean;
  /** Where the caret belongs after a chip was put in, or null. */
  caret: number | null;
  onCaretApplied: () => void;
  onChange: (value: string) => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  // In the same commit as the new text, before the frame is painted: typing
  // right after a chip is never inserted at the old caret.
  useLayoutEffect(() => {
    if (caret === null) return;
    const field = ref.current;
    if (field !== null) {
      field.focus();
      field.setSelectionRange(caret, caret);
    }
    onCaretApplied();
  }, [caret, onCaretApplied, ref]);
  return (
    <div className="pl__content">
      <div ref={backdrop} className="pl__backdrop" aria-hidden="true">
        {splitVariables(value).map((part, i) =>
          part.variable ? (
            <mark key={i} className="pl__mark">
              {part.text}
            </mark>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
        {'\n'}
      </div>
      <textarea
        ref={ref}
        className="pl__textarea"
        value={value}
        readOnly={readOnly}
        maxLength={PROMPT_CONTENT_MAX}
        aria-label={t('prompts.content')}
        spellCheck={false}
        onScroll={(e) => {
          const el = backdrop.current;
          if (el !== null) el.scrollTop = e.currentTarget.scrollTop;
        }}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

/** The AI candidate: a diff against the prompt's content, with the shared bar. */
function CandidateView({
  candidate,
  onRetry,
  onDiscard,
  onKeep,
}: {
  candidate: Candidate;
  onRetry: () => void;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  const segments = diffSentences(candidate.original, candidate.result.candidate.content);
  return (
    <>
      <div className="pl__diff" role="group" aria-label={t('ai.candidate')}>
        {segments.map((s: Segment, i) =>
          s.kind === 'same' ? (
            <span key={i}>
              <Marked text={s.text} />
            </span>
          ) : (
            <span key={i}>
              {s.before !== '' && (
                <del className="del">
                  <Marked text={s.before} />
                </del>
              )}
              {s.after !== '' && (
                <ins className="ins">
                  <Marked text={s.after} />
                </ins>
              )}
            </span>
          ),
        )}
      </div>
      <div className="cand-bar" role="group" aria-label={t('ai.candidate')}>
        <span className="cand-bar__m">
          <Icon name="spark" size={13} />
          {candidate.original === ''
            ? t('prompts.candidateNew')
            : t('prompts.candidateEdit', {
                change: changeCount(candidate.original, candidate.result.candidate.content),
              })}
        </span>
        <button type="button" className="btn btn--ghost btn--small" onClick={onRetry}>
          {t('common.retry')}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          aria-keyshortcuts="Escape"
          onClick={onDiscard}
        >
          {t('ai.discard')}
          <kbd>esc</kbd>
        </button>
        <button
          type="button"
          className="btn btn--primary btn--small"
          aria-keyshortcuts="Meta+Enter"
          onClick={onKeep}
        >
          {t('ai.keep')}
          <kbd>⌘↩</kbd>
        </button>
      </div>
    </>
  );
}

/** Text with this version's variables marked, as the content field marks them. */
function Marked({ text }: { text: string }) {
  return (
    <>
      {splitVariables(text).map((part, i) =>
        part.variable ? (
          <mark key={i} className="pl__mark">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
