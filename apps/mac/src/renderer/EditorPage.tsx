import { sessionHandle, type EditorTabHandle } from './tab-handle.js';
import type { CreatorHubClient } from '@qiu-creator/api-client';
import type {
  AssetRecord,
  Prompt,
  Revision,
  RewriteMode,
  WorkDetail,
  WorkStatus,
} from '@qiu-creator/contracts';
import {
  blockEndAt,
  blockNumbers,
  MarkdownEditor,
  type EditorMode,
  type MarkdownEditorHandle,
  type MarkdownRange,
} from '@qiu-creator/markdown-editor-web';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { codeText, t, useLocale } from './i18n.js';
import { AiPanel, type AiSelection, type AiTab } from './AiPanel.js';
import { AI_BLOCK_LABEL, AiProviders, RewriteSession } from './ai-session.js';
import { ImageGenSession, pendingCandidates } from './ai-images.js';
import { chooseModel, useCostConfirm } from './AiImageTab.js';
import { InlineAi } from './InlineAi.js';
import { SelectionToolbar, type ToolbarAction } from './SelectionToolbar.js';
import { Chip } from './Chip.js';
import { SaveChip } from './SaveChip.js';
import { ConflictDialog } from './ConflictDialog.js';
import { useChangeEvents, useEventStatus } from './events.js';
import { countWords, WORK_STATUS } from './format.js';
import { HistoryPanel } from './HistoryPanel.js';
import { Icon } from './Icon.js';
import { useToast } from './toasts.js';
import { WorkMediaResolver } from './media.js';
import { externalSource, useMounts } from './mounts.js';
import { TagEditor } from './TagEditor.js';
import { ProjectTags } from './ProjectTags.js';
import { PreviewPanel } from './PreviewPanel.js';
import { currentModel, useAiLibrary } from './ai-library.js';
import type { TabStatusPatch, TabView } from './tabs.js';
import { EditorSide, useSideStore } from './EditorSide.js';
import { LiveBanner } from './AgentLive.js';
import { ProposalsSideTab, usePendingFor, type TextRange } from './ProposalsSideTab.js';
import {
  WorkSession,
  type Draft,
  type ReadOnlyReason,
  type RemoteChange,
  type SaveError,
} from './work-session.js';
import { imageFiles, InsertSession, type InsertState, type InsertWhere } from './editor-insert.js';
import {
  ASSET_DRAG_TYPE,
  AssetDrawer,
  DropIndicator,
  dropFrame,
  dropScrollStep,
  type DropFrame,
  InsertMenu,
  PendingInserts,
  SlashMenu,
  type SlashCommand,
} from './InsertUI.js';

const STATUS_ORDER: readonly WorkStatus[] = ['drafting', 'in_review', 'ready', 'published'];
const EMPTY_INSERT: InsertState = { pending: [], notice: null };

/** True when the caret sits in an empty block (where `/` opens the insert menu). */
function caretInEmptyBlock(root: Element | null, source: HTMLTextAreaElement | null): boolean {
  if (source !== null) {
    const v = source.value;
    const at = source.selectionStart;
    if (at !== source.selectionEnd) return false;
    const start = v.lastIndexOf('\n', at - 1) + 1;
    const end = v.indexOf('\n', at);
    return v.slice(start, end === -1 ? v.length : end).trim() === '';
  }
  const sel = window.getSelection();
  if (root === null || sel === null || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  let n: Node | null = sel.anchorNode;
  while (n !== null && n.parentNode !== root) n = n.parentNode;
  return n instanceof Element && n.textContent.trim() === '';
}

/**
 * Visual mode: the Markdown block boundary at the empty block holding the caret.
 * An empty paragraph is not in the Markdown, so count the non-empty blocks before it.
 */
function emptyBlockBoundary(root: Element | null): number | null {
  const sel = window.getSelection();
  if (root === null || sel === null || sel.rangeCount === 0) return null;
  let n: Node | null = sel.anchorNode;
  while (n !== null && n.parentNode !== root) n = n.parentNode;
  if (!(n instanceof Element)) return null;
  let count = 0;
  for (const child of Array.from(root.children)) {
    if (child === n) return count;
    const empty =
      child.tagName !== 'HR' &&
      child.textContent.trim() === '' &&
      Array.from(child.children).every((ch) => ch.tagName === 'BR');
    if (!empty) count += 1;
  }
  return null;
}

/** Where the caret is on screen, for the `/` menu. */
function caretPoint(source: HTMLTextAreaElement | null): { x: number; y: number } | null {
  if (source !== null) {
    const r = source.getBoundingClientRect();
    const style = getComputedStyle(source);
    const line = parseFloat(style.lineHeight) || 24;
    const before = source.value.slice(0, source.selectionStart).split('\n').length - 1;
    return {
      x: r.left + (parseFloat(style.paddingLeft) || 0),
      y: r.top + (parseFloat(style.paddingTop) || 0) + (before + 1) * line - source.scrollTop,
    };
  }
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  let rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    const el =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    if (el === null) return null;
    rect = el.getBoundingClientRect();
  }
  return { x: rect.left, y: rect.bottom + 4 };
}

const REMOTE_LABEL: Readonly<Record<RemoteChange['source'], string>> = {
  get external() {
    return t('editor.remoteExternal');
  },
  get edit() {
    return t('editor.remoteEdit');
  },
  get restore() {
    return t('editor.remoteRestore');
  },
  get other() {
    return t('editor.remoteOther');
  },
};

/** What to do about a read-only work, plus the promise that unsaved edits are kept. */
function readOnlyHint(reason: ReadOnlyReason, session: WorkSession): string {
  const hint = t(
    reason === 'missing' ? 'editor.readOnlyMissingHint' : 'editor.readOnlyUnmountedHint',
  );
  return session.hasUnsavedChanges() ? t('editor.readOnlyHintKept', { hint }) : hint;
}

/** Why the last save failed, in the user's words (never the service's own message). */
function saveErrorText(error: SaveError | null): string {
  if (error === null) return t('editor.saveFailed');
  if (error.kind === 'title_blank') return t('editor.titleRequired');
  if (error.kind === 'offline') return t('editor.saveOffline');
  return codeText(error.code);
}

export interface EditorPageProps {
  client: CreatorHubClient;
  work: WorkDetail;
  /** For showing mount folders as `~/…`. */
  userHome: string | null;
  onBack: () => void;
  /** QC-097: 活動記錄 in the live agent bar (設定 › Agent 與 MCP). */
  onOpenAgentActivity?: () => void;
  /** 「前往設定」 from the AI panel when no key or consent is set. */
  onOpenSettings?: () => void;
  /** 管理 Prompt (QC-075). */
  onOpenPrompts?: () => void;
  /**
   * QC-047: false while this editor's tab is in the background. Background
   * editors stay mounted (draft, caret, scroll, panels intact) but handle no
   * shortcuts. Defaults to true.
   */
  active?: boolean;
  /** Bumped when the tab is brought forward by a click or shortcut: the caret goes back into the text. */
  focusToken?: number;
  /** Where the user was when this tab was last unloaded or restored. */
  initialView?: TabView;
  /** A draft discarded by 不儲存並關閉 and brought back by 重新開啟. */
  initialDraft?: Draft | null;
  /** Title and badges for the tab. */
  onTabStatus?: (patch: TabStatusPatch) => void;
  /** Mode, caret, scroll and panel when the tab goes to the background or is unloaded. */
  onViewChange?: (view: TabView) => void;
  /** Lets the tab bar save or discard this editor's draft when its tab is closed. */
  onHandle?: (handle: EditorTabHandle | null) => void;
}

/** What the tab bar may do with an open editor (QC-047). */
export type { EditorTabHandle } from './tab-handle.js';

/**
 * 編輯頁 from the approved prototype plus PT-20261117-001: live
 * external-change notice, missing-file read-only state, external source
 * label, status and tags, Markdown images, history with restore, and the AI
 * panel (QC-024), which history replaces while open.
 */
export function EditorPage(props: EditorPageProps) {
  const { client, work, onHandle } = props;
  const [session, setSession] = useState<WorkSession | null>(null);
  const initialDraft = useRef(props.initialDraft ?? null);
  useEffect(() => {
    const s = new WorkSession(client, work);
    let discarded = false;
    // 重新開啟 after 不儲存並關閉: the discarded edits come back as unsaved edits.
    const back = initialDraft.current;
    initialDraft.current = null;
    if (back !== null) s.edit(back);
    setSession(s);
    onHandle?.(
      sessionHandle(s, () => {
        discarded = true;
      }),
    );
    return () => {
      onHandle?.(null);
      // Flush pending edits when leaving; a conflict stays unsaved (the dialog blocks leaving).
      if (!discarded) s.close();
    };
  }, [client, work, onHandle]);

  if (session === null) return <main className="page" aria-busy="true" />;
  return <SessionEditor {...props} session={session} />;
}

/** Revision number (r1, r2, …) for each revision id; the list comes newest first. */
function revisionNumbers(revisions: readonly Revision[]): Map<string, number> {
  return new Map(revisions.map((r, i) => [r.revision_id, revisions.length - i]));
}

function SessionEditor({
  client,
  work,
  userHome,
  onBack,
  onOpenAgentActivity,
  onOpenSettings,
  onOpenPrompts,
  session,
  active = true,
  focusToken = 0,
  initialView,
  onTabStatus,
  onViewChange,
}: EditorPageProps & { session: WorkSession }) {
  const locale = useLocale();
  const state = useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    () => session.snapshot,
  );
  const editor = useRef<MarkdownEditorHandle>(null);
  /** Bumped when the draft is replaced from outside the editor, to remount it. */
  const [editorKey, setEditorKey] = useState(0);
  const [mode, setMode] = useState<EditorMode>('visual');
  // Only `source` is forced back: visual is the default, and a document it cannot take stays in source.
  const forcedMode = useRef<EditorMode | undefined>(
    initialView?.mode === 'source' ? 'source' : undefined,
  );
  // QC-085: 預覽, AI, 歷史 and 素材 are tabs of the window's right sidebar (⌘⇧P, ⌘⇧I, ⌥⌘0).
  const side = useSideStore();
  const sideState = useSyncExternalStore(side.subscribe, side.getSnapshot);
  // QC-091: the 提案 tab while the work has pending agent proposals; its changes light up in the text.
  const pendingProposals = usePendingFor(work.id);
  const proposalsShown =
    pendingProposals > 0 &&
    (sideState.drawer ? sideState.drawerOpen : sideState.prefs.open) &&
    sideState.prefs.tab === 'proposals';
  const [proposalHits, setProposalHits] = useState<readonly TextRange[]>([]);
  const onOverLimit = useCallback(
    (over: boolean) => {
      side.setOver(work.id, over);
    },
    [side, work.id],
  );
  const [slashAt, setSlashAt] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** A prompt saved to the library, which is not on screen. */
  const [okNotice, setOkNotice] = useState<string | null>(null);
  const { state: aiChoices } = useAiLibrary();
  useEffect(() => {
    if (okNotice === null) return;
    const timer = setTimeout(() => {
      setOkNotice(null);
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [okNotice]);
  /** Where the next insert from the `/` menu goes (computed when `/` is pressed). */
  const pendingWhere = useRef<InsertWhere | null>(null);
  const takeWhere = (): InsertWhere => {
    const w = pendingWhere.current ?? 'caret';
    pendingWhere.current = null;
    return w;
  };
  useEffect(() => {
    if (notice === null) return;
    const t = setTimeout(() => {
      setNotice(null);
    }, 5000);
    return () => {
      clearTimeout(t);
    };
  }, [notice]);
  const [drop, setDrop] = useState<{
    frame: DropFrame;
    y: number | null;
    label: string;
    where: InsertWhere;
  } | null>(null);
  const draggedAsset = useRef<AssetRecord | null>(null);
  const docRef = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [insert, setInsert] = useState<InsertSession | null>(null);
  useEffect(() => {
    // Created in the effect: StrictMode would dispose an instance made during render.
    const s = new InsertSession({
      client,
      workId: work.id,
      insert: (markdown, where) => {
        editor.current?.insertBlock(markdown, where);
      },
      bridge: window.creatorhub ?? null,
      createPreview: (blob) => URL.createObjectURL(blob),
      revokePreview: (url) => {
        URL.revokeObjectURL(url);
      },
    });
    setInsert(s);
    return () => {
      s.dispose();
    };
  }, [client, work.id]);
  const insertState = useSyncExternalStore(
    useCallback((cb: () => void) => insert?.subscribe(cb) ?? (() => undefined), [insert]),
    () => insert?.getSnapshot() ?? EMPTY_INSERT,
  );
  useEffect(() => {
    if (insertState.notice === null) return;
    const t = setTimeout(() => insert?.dismissNotice(), 5000);
    return () => {
      clearTimeout(t);
    };
  }, [insertState.notice, insert]);
  const [revisions, setRevisions] = useState<readonly Revision[]>([]);

  const loadRevisions = useCallback(() => {
    client.works
      .revisions(work.id)
      .then((r) => {
        setRevisions(r.items);
      })
      .catch(() => {
        // history is informational; the save status already reports connectivity
      });
  }, [client, work.id]);
  useEffect(loadRevisions, [loadRevisions, state.baseRevision]);
  const numbers = useMemo(() => revisionNumbers(revisions), [revisions]);

  // AI panel (QC-024): sessions live as long as this editor.
  const [ai, setAi] = useState<{
    providers: AiProviders;
    rewrite: RewriteSession;
    images: ImageGenSession;
  } | null>(null);
  useEffect(() => {
    const providers = new AiProviders(client);
    const rewrite = new RewriteSession(client, session, providers);
    const images = new ImageGenSession(client, session, providers);
    setAi({ providers, rewrite, images });
    void rewrite.loadProvider();
    void images.load();
    return () => {
      rewrite.dispose();
      images.dispose();
    };
  }, [client, session, work.id]);
  /** A rewrite asked for from the selection toolbar in the visual editor: shown in place (QC-070). */
  const [rewriteTarget, setRewriteTarget] = useState<{
    range: MarkdownRange;
    mode: RewriteMode;
    /** A prompt from the library (QC-075): its name is said instead of the mode. */
    prompt?: Prompt;
  } | null>(null);
  const closeRewriteTarget = useCallback(() => {
    setRewriteTarget(null);
  }, []);
  const [tabRequest, setTabRequest] = useState<{ tab: AiTab; n: number } | undefined>(undefined);
  const showAiTab = (tab: AiTab) => {
    side.show('ai');
    setTabRequest((r) => ({ tab, n: (r?.n ?? 0) + 1 }));
  };
  const costConfirm = useCostConfirm();
  const imageState = useSyncExternalStore(
    useCallback((cb: () => void) => ai?.images.subscribe(cb) ?? (() => undefined), [ai]),
    () => ai?.images.snapshot ?? null,
  );
  const unkeptImages = imageState === null ? 0 : pendingCandidates(imageState);
  const imagesBusy = imageState?.jobs.some((j) => j.phase === 'generating') === true;
  const [selectionRange, setSelectionRange] = useState<MarkdownRange | null>(null);
  useEffect(() => {
    setSelectionRange(null);
  }, [state.epoch, editorKey]);
  const aiSelection = useMemo((): AiSelection => {
    const md = state.draft.markdown;
    const range =
      selectionRange !== null &&
      selectionRange.end <= md.length &&
      selectionRange.end > selectionRange.start
        ? selectionRange
        : null;
    if (range === null)
      return { range: null, label: t('editor.selectionAll'), words: countWords(md) };
    const n = blockNumbers(md, range);
    const label =
      n === null
        ? t('editor.selectionAll')
        : n.first === n.last
          ? t('editor.selectionParagraph', { n: n.first })
          : t('editor.selectionParagraphs', { first: n.first, last: n.last });
    return { range, label, words: countWords(md.slice(range.start, range.end)) };
  }, [selectionRange, state.draft.markdown, locale]);

  /** Where 插入到游標處 puts an image: after the block holding the last caret. */
  const insertOffset = useCallback((): number => {
    const md = state.draft.markdown;
    return blockEndAt(md, Math.min(selectionRange?.end ?? md.length, md.length));
  }, [state.draft.markdown, selectionRange]);

  /** 配圖 is off without New API or without an image model: say why. */
  const imageDisabledReason =
    imageState === null
      ? null
      : imageState.block !== null
        ? AI_BLOCK_LABEL[imageState.block]
        : imageState.models !== null && imageState.models.length === 0
          ? t('ai.noImageModel')
          : null;

  /** The selection toolbar's actions (QC-070). */
  const onToolbar = (action: ToolbarAction, range: MarkdownRange) => {
    if (ai === null) return;
    const md = state.draft.markdown;
    if (action.kind === 'image') {
      const model = chooseModel(imageState?.models ?? null);
      if (model === '') {
        setNotice(t('ai.noImageModel'));
        return;
      }
      const prompt = md.slice(range.start, range.end).trim().slice(0, 4000);
      const request = {
        purpose: 'image' as const,
        model,
        prompt,
        aspectRatio: '16:9' as const,
        count: 2,
      };
      void ai.images.estimate(request).then(async (est) => {
        const unknown = est !== null && est.estimate.max_cost_usd === null;
        if (!(await costConfirm.confirm(model, unknown))) return;
        if (mode === 'visual') {
          await ai.images.generate(request, {
            origin: 'inline',
            anchor: blockEndAt(md, range.end),
          });
        } else {
          // Source mode never covers the text: the images come in the side panel.
          showAiTab('image');
          await ai.images.generate(request, { origin: 'panel' });
        }
      });
      return;
    }
    const model = currentModel(aiChoices, 'rewrite');
    if (action.kind === 'prompt') {
      const p = action.prompt;
      if (mode === 'visual') setRewriteTarget({ range, mode: 'custom', prompt: p });
      else showAiTab('rewrite');
      void ai.rewrite.generate({ promptId: p.id, model, range });
      return;
    }
    const input = {
      mode: action.mode,
      ...(action.mode === 'tone' ? { tone: action.tone } : {}),
      ...(action.mode === 'custom' ? { instruction: action.instruction } : {}),
      model,
      range,
    };
    if (mode === 'visual') setRewriteTarget({ range, mode: action.mode });
    else showAiTab('rewrite');
    void ai.rewrite.generate(input);
  };

  /** 「用 AI 縮寫」 from the preview (QC-084): the whole text, as a candidate with diff. */
  const shortenAll = (limit: number) => {
    if (ai === null) return;
    const range = { start: 0, end: state.draft.markdown.length };
    if (mode === 'visual') setRewriteTarget({ range, mode: 'custom' });
    else showAiTab('rewrite');
    void ai.rewrite.generate({
      mode: 'custom',
      instruction: t('previewPanel.shortenInstruction', { limit }),
      model: currentModel(aiChoices, 'rewrite'),
      range,
    });
  };

  const mounts = useMounts(client);
  const source = externalSource(work, mounts, userHome);

  const media = useMemo(
    () =>
      new WorkMediaResolver({
        load: () => client.works.media(work.id),
        absolute: (relative) => client.media.absoluteUrl(relative),
        // A newly typed image only resolves after the Markdown that names it is saved.
        beforeLookup: () => session.save(),
      }),
    [client, work.id, session],
  );
  const resolveImage = useCallback((src: string) => media.resolve(src), [media]);

  // Live changes to this work from the shared SSE channel.
  useChangeEvents((event) => {
    if (event.entity === 'job' && event.action.startsWith('ai_job.')) {
      void ai?.rewrite.jobChanged(event.entity_id);
      void ai?.images.jobChanged(event.entity_id);
      return;
    }
    if (event.entity !== 'work' || event.entity_id !== work.id) return;
    const rid = typeof event.data['revision_id'] === 'string' ? event.data['revision_id'] : null;
    switch (event.action) {
      case 'work.external_revision':
        media.invalidate();
        if (rid !== null) void session.remoteRevision(rid, 'external');
        loadRevisions();
        break;
      case 'work.updated': {
        media.invalidate();
        const src = event.data['source'];
        if (rid !== null) {
          void session.remoteRevision(
            rid,
            src === 'edit' || src === 'restore' || src === 'external' ? src : 'other',
          );
        }
        loadRevisions();
        break;
      }
      case 'work.assets_changed':
        media.invalidate();
        break;
      case 'work.source_missing':
      case 'work.source_restored':
        session
          .refreshExternalState()
          .then(loadRevisions)
          .catch(() => undefined);
        break;
      default:
        break;
    }
  });
  // After a dropped connection, catch up with whatever happened meanwhile.
  const eventStatus = useEventStatus();
  const previousStatus = useRef(eventStatus);
  useEffect(() => {
    if (previousStatus.current === 'reconnecting' && eventStatus === 'open') {
      void session
        .refreshExternalState()
        .then(() =>
          client.works
            .get(work.id)
            .then((w) => session.remoteRevision(w.current_revision_id, 'other')),
        );
      loadRevisions();
    }
    previousStatus.current = eventStatus;
  }, [eventStatus, session, client, work.id, loadRevisions]);

  useEffect(() => {
    const m = editor.current?.getMode();
    if (m !== undefined) setMode(m);
  }, [editorKey, state.epoch]);

  // ⌘S save now, ⌘/ switch mode; never during IME composition. Background tabs listen to nothing.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.isComposing || session.isComposing()) return;
      if (!e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void session.save();
      } else if (e.key === '/') {
        e.preventDefault();
        editor.current?.requestMode(editor.current.getMode() === 'visual' ? 'source' : 'visual');
      } else if (e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        fileInput.current?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [session, active]);

  // ---- QC-047: tab badges and where the user was ----------------------------------------------
  useEffect(() => {
    onTabStatus?.({
      title: state.draft.title,
      unsaved: session.hasUnsavedChanges(),
      conflict: state.status === 'conflict' || state.remote !== null,
    });
  }, [state, session, onTabStatus]);
  const rewriteState = useSyncExternalStore(
    useCallback((cb: () => void) => ai?.rewrite.subscribe(cb) ?? (() => undefined), [ai]),
    () => ai?.rewrite.snapshot ?? null,
  );
  useEffect(() => {
    onTabStatus?.({
      aiCandidate: rewriteState?.candidate != null || unkeptImages > 0,
      aiBusy: rewriteState?.phase === 'loading' || imagesBusy,
    });
  }, [rewriteState, unkeptImages, imagesBusy, onTabStatus]);

  /** Kept up to date while the tab is in front, read when it goes to the background or unloads. */
  const where = useRef<{
    scrollTop: number;
    selection: TabView['selection'];
    domRange: Range | null;
  }>({
    scrollTop: initialView?.scrollTop ?? 0,
    selection: initialView?.selection ?? null,
    domRange: null,
  });
  const latest = useRef({ mode, onViewChange });
  latest.current = { mode, onViewChange };
  /** Read the caret from the DOM now, if it is inside the document. */
  const rememberSelection = useCallback(() => {
    const doc = docRef.current;
    const sel = window.getSelection();
    if (doc === null || sel === null || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!doc.contains(range.startContainer)) return;
    const ta = sourceArea();
    where.current.selection =
      ta !== null
        ? { start: ta.selectionStart, end: ta.selectionEnd }
        : (editor.current?.getSelectionRange() ?? where.current.selection);
    where.current.domRange = ta !== null ? null : range.cloneRange();
  }, []);
  useEffect(() => {
    if (!active) return;
    document.addEventListener('selectionchange', rememberSelection);
    return () => {
      document.removeEventListener('selectionchange', rememberSelection);
    };
  }, [active, rememberSelection]);
  const reportView = useCallback(() => {
    const { mode: m, onViewChange: report } = latest.current;
    report?.({
      mode: m,
      selection: where.current.selection,
      scrollTop: where.current.scrollTop,
    });
  }, []);
  // The text scrolls in the document (visual) or inside the source textarea.
  useEffect(() => {
    const doc = docRef.current;
    if (!active || doc === null) return;
    const onScroll = (e: Event) => {
      const el = e.target;
      if (el === doc || (el instanceof HTMLTextAreaElement && doc.contains(el))) {
        where.current.scrollTop = (el as HTMLElement).scrollTop;
      }
    };
    doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      doc.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [active]);
  // Leaving the front: read the scroll position and the caret from the DOM before the pane
  // is hidden (layout cleanups run before the parent's `hidden` is applied), in case the
  // last scroll or selectionchange event has not fired yet (QC-059).
  useLayoutEffect(() => {
    if (!active) return;
    return () => {
      const doc = docRef.current;
      if (doc !== null) where.current.scrollTop = (sourceArea() ?? doc).scrollTop;
      rememberSelection();
    };
  }, [active, rememberSelection]);
  // The mode is saved as it changes, so a quit keeps it for the next launch.
  useEffect(() => {
    if (active) reportView();
  }, [mode, active, reportView]);
  // Going to the background: hand the view to the tab (it may be unloaded later).
  // Coming back: AI keys and consent may have changed in 設定 meanwhile, so re-read them
  // (before tabs, leaving the editor unmounted it and the panel started fresh).
  const wasActive = useRef(active);
  const [providersEpoch, setProvidersEpoch] = useState(0);
  useEffect(() => {
    if (wasActive.current && !active) reportView();
    if (!wasActive.current && active && ai !== null) {
      ai.providers.invalidate();
      void ai.rewrite.loadProvider();
      setProvidersEpoch((n) => n + 1);
    }
    wasActive.current = active;
  }, [active, reportView, ai]);
  // Unloading: report before the DOM goes (layout cleanup runs before the children detach).
  useLayoutEffect(() => reportView, [reportView]);
  // Back in front (or first shown): scroll back, and on a click or shortcut, the caret too.
  const handledFocus = useRef(-1);
  useEffect(() => {
    if (!active) return;
    const wantFocus = handledFocus.current !== focusToken;
    handledFocus.current = focusToken;
    const frame = requestAnimationFrame(() => {
      const doc = docRef.current;
      if (doc === null) return;
      const scroller = (): HTMLElement => sourceArea() ?? doc;
      scroller().scrollTop = where.current.scrollTop;
      if (!wantFocus) return;
      const range = where.current.domRange;
      const content = doc.querySelector<HTMLElement>('.qc-md-editor__content');
      if (range !== null && content !== null && content.contains(range.startContainer)) {
        content.focus({ preventScroll: true });
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } else if (where.current.selection !== null) {
        editor.current?.restoreSelection(where.current.selection);
      }
      scroller().scrollTop = where.current.scrollTop;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
    // `editorKey`/`epoch`: a remount needs its caret and scroll put back as well.
  }, [active, focusToken, editorKey, state.epoch]);
  useEffect(() => {
    forcedMode.current = undefined;
  }, []);

  // The proposal's changes, framed in the visual text while 提案 is in front (QC-091).
  useEffect(() => {
    if (!proposalsShown || mode !== 'visual' || proposalHits.length === 0) return;
    const frame = requestAnimationFrame(() => {
      for (const r of proposalHits) {
        for (const el of editor.current?.blockElements(r) ?? []) el.dataset['proposalHit'] = '';
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const el of docRef.current?.querySelectorAll<HTMLElement>('[data-proposal-hit]') ?? []) {
        delete el.dataset['proposalHit'];
      }
    };
  }, [proposalsShown, mode, proposalHits, editorKey, state.epoch, state.draft.markdown]);

  const readOnly = state.readOnly !== null;
  // External works keep their images in their own folder; nothing is copied into it (QC-039).
  const insertBlocked: string | null = readOnly
    ? t('editor.insertBlockedReadOnly')
    : work.storage_mode === 'external'
      ? t('editor.insertBlockedExternal')
      : null;
  const openDrawer = () => {
    side.show('assets');
  };
  const slashCommands: SlashCommand[] = [
    {
      key: 'library',
      label: t('editor.slashLibrary'),
      hint: '⌘⇧I',
      icon: 'assets',
      run: openDrawer,
    },
    {
      key: 'upload',
      label: t('editor.uploadImage'),
      hint: '⌘⇧U',
      icon: 'upload',
      run: () => {
        fileInput.current?.click();
      },
    },
    {
      key: 'divider',
      label: t('editor.slashDivider'),
      hint: '---',
      icon: 'lines',
      run: () => {
        editor.current?.insertBlock('---', takeWhere());
      },
    },
  ];
  const sourceArea = () =>
    docRef.current?.querySelector<HTMLTextAreaElement>('textarea.qc-md-editor__source') ?? null;
  const dropTarget = (clientY: number): { where: InsertWhere; y: number | null } => {
    const doc = docRef.current;
    const b = editor.current?.boundaryAt(clientY) ?? null;
    if (doc === null || b === null) return { where: 'caret', y: null };
    const top = doc.getBoundingClientRect().top;
    return { where: { beforeBlock: b.index }, y: b.y - top + doc.scrollTop };
  };
  const dragKind = (types: readonly string[]): 'asset' | 'files' | null =>
    types.includes(ASSET_DRAG_TYPE) ? 'asset' : types.includes('Files') ? 'files' : null;
  const rev = numbers.get(state.baseRevision);
  const words = useMemo(() => countWords(state.draft.markdown), [state.draft.markdown]);
  const conflict = state.status === 'conflict';
  // The dialog opens on a 409 and stays open after resolving, until 返回編輯.
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    if (conflict) setDialogOpen(true);
  }, [conflict]);
  const remoteN = state.remote === null ? undefined : numbers.get(state.remote.revisionId);
  // Notices go through the shared queue (QC-045); a background tab shows none.
  const shownNotice = notice ?? okNotice ?? insertState.notice;
  useToast(
    !active || shownNotice === null
      ? null
      : {
          message: shownNotice,
          tone: notice === null && okNotice !== null ? 'ok' : 'bad',
          onClose: () => {
            setNotice(null);
            setOkNotice(null);
            insert?.dismissNotice();
          },
        },
  );

  return (
    <>
      <main className="page editor" aria-label={t('editor.pageLabel')} inert={dialogOpen}>
        <header className="editor__bar">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label={t('editor.backToLibrary')}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
          <input
            className="editor__title"
            aria-label={t('editor.titleLabel')}
            readOnly={readOnly}
            value={state.draft.title}
            onChange={(e) => {
              session.edit({ title: e.target.value });
            }}
            onCompositionStart={() => {
              session.setComposing(true);
            }}
            onCompositionEnd={() => {
              session.setComposing(false);
            }}
          />
          {source !== null && (
            <span className="src-ext" title={source.file ?? undefined}>
              <Icon name="folder" size={12} />
              {source.folder === null ? (
                source.label
              ) : (
                <>
                  {t('format.sourceExternal')} · <span className="mono">{source.folder}</span>
                </>
              )}
            </span>
          )}
          <span className="save-status" role="status" aria-live="polite">
            <SaveChip
              status={state.status}
              readOnly={readOnly}
              onAct={() => {
                if (conflict) setDialogOpen(true);
                else void session.save();
              }}
            />
            {(unkeptImages > 0 || rewriteState?.candidate != null) && (
              <span className="chip chip--warn editor__unkept">{t('ai.unkept')}</span>
            )}
          </span>
          {state.status === 'error' && (
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                void session.save();
              }}
            >
              {t('common.retry')}
            </button>
          )}
          {rev !== undefined && <Chip>r{rev}</Chip>}
          <span className="editor__words">{t('editor.wordCount', { count: words })}</span>
          <div className="editor__actions">
            <div className="seg" role="group" aria-label={t('editor.modeGroup')}>
              {(['visual', 'source'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  aria-keyshortcuts="Meta+/"
                  onClick={() => {
                    editor.current?.requestMode(m);
                  }}
                >
                  {t(m === 'visual' ? 'editor.modeVisual' : 'editor.modeSource')}
                </button>
              ))}
            </div>
            <InsertMenu
              disabled={insertBlocked !== null}
              disabledReason={insertBlocked}
              onLibrary={openDrawer}
              onUpload={() => {
                fileInput.current?.click();
              }}
            />
          </div>
        </header>

        <div className="editor__meta">
          <label className="meta-field">
            <span className="faint">{t('editor.statusLabel')}</span>
            <select
              className="select"
              value={state.draft.status}
              disabled={readOnly}
              onChange={(e) => {
                session.edit({ status: e.target.value as WorkStatus });
              }}
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {WORK_STATUS[s].label}
                </option>
              ))}
            </select>
          </label>
          <TagEditor
            tags={state.draft.tags}
            disabled={readOnly}
            onChange={(tags) => {
              session.edit({ tags });
            }}
          />
          <ProjectTags
            client={client}
            workId={work.id}
            title={state.draft.title}
            initial={work.project_ids}
          />
        </div>

        {/* QC-097: an agent working on this work right now. */}
        <LiveBanner
          client={client}
          workId={work.id}
          typing={session.hasUnsavedChanges()}
          onSeeChanges={() => {
            side.show('history');
          }}
          onOpenActivity={() => {
            onOpenAgentActivity?.();
          }}
        />

        {state.readOnly !== null && (
          <div className="banner banner--bad" role="alert">
            <Icon name="alert" />
            <span className="banner__text banner__text--wrap">
              <span>
                {t(
                  state.readOnly === 'missing'
                    ? 'editor.readOnlyMissing'
                    : 'editor.readOnlyUnmounted',
                )}
              </span>
              {source?.file != null && <span className="mono banner__path">{source.file}</span>}
              <span className="banner__hint">{readOnlyHint(state.readOnly, session)}</span>
            </span>
            {state.readOnly === 'missing' && work.mount_id != null && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (work.mount_id != null) {
                    void window.creatorhub?.reveal({ kind: 'mount', id: work.mount_id });
                  }
                }}
              >
                {t('editor.revealFolder')}
              </button>
            )}
          </div>
        )}

        {state.remote !== null && (
          <div className="banner banner--warn" role="alert">
            <Icon name="alert" />
            <span className="banner__text">
              {t('editor.remoteChanged', { source: REMOTE_LABEL[state.remote.source] })}
              {remoteN !== undefined && ` · r${remoteN}`}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                session.compareRemote();
              }}
            >
              {t('editor.compareMerge')}
            </button>
            <button
              type="button"
              className="btn btn--ghost banner__warn-action"
              onClick={() => {
                session.reloadFromServer().catch(() => undefined);
              }}
            >
              {t('editor.discardReload')}
            </button>
          </div>
        )}

        {state.status === 'error' && (
          <div className="banner banner--bad" role="alert">
            <Icon name="alert" />
            <span className="banner__text">{saveErrorText(state.error)}</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void session.save();
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        )}

        <div className="editor__body">
          <section
            ref={docRef}
            className={readOnly ? 'editor__doc editor__doc--readonly' : 'editor__doc'}
            aria-label={t('editor.docLabel')}
            onKeyDownCapture={(e) => {
              // `/` on an empty line opens the insert menu instead of typing a slash.
              if (
                e.key !== '/' ||
                e.metaKey ||
                e.ctrlKey ||
                e.altKey ||
                e.nativeEvent.isComposing
              ) {
                return;
              }
              if (insertBlocked !== null) return;
              const root = docRef.current?.querySelector('.qc-md-editor__content') ?? null;
              const source = sourceArea();
              if (
                !caretInEmptyBlock(
                  mode === 'source' ? null : root,
                  mode === 'source' ? source : null,
                )
              ) {
                return;
              }
              const at = caretPoint(mode === 'source' ? source : null);
              if (at === null) return;
              e.preventDefault();
              e.stopPropagation();
              const boundary = mode === 'source' ? null : emptyBlockBoundary(root);
              pendingWhere.current = boundary === null ? 'caret' : { beforeBlock: boundary };
              setSlashAt(at);
            }}
            onPasteCapture={(e) => {
              const images = imageFiles([...e.clipboardData.files]);
              if (images.length === 0) return;
              e.preventDefault();
              e.stopPropagation();
              if (insertBlocked !== null) return;
              for (const f of images) void insert?.pasteImage(f, 'caret');
            }}
            onDragOverCapture={(e) => {
              const kind = dragKind([...e.dataTransfer.types]);
              if (kind === null) return;
              e.preventDefault();
              e.stopPropagation();
              if (insertBlocked !== null) {
                e.dataTransfer.dropEffect = 'none';
                return;
              }
              e.dataTransfer.dropEffect = 'copy';
              const doc = e.currentTarget;
              // Near the top or bottom edge, scroll so the line can reach any block.
              const docTop = doc.getBoundingClientRect().top + doc.clientTop;
              const before = dropFrame(doc);
              const step = dropScrollStep(
                e.clientY,
                docTop + before.top - doc.scrollTop,
                docTop + before.top - doc.scrollTop + before.height,
              );
              if (step !== 0) doc.scrollTop += step;
              const frame = dropFrame(doc);
              const target = dropTarget(e.clientY);
              const n = [...e.dataTransfer.items].filter((i) => i.kind === 'file').length;
              const dragged = draggedAsset.current;
              const label =
                kind === 'asset'
                  ? t('editor.dropInsertAsset', {
                      name:
                        dragged === null
                          ? t('editor.assets')
                          : (dragged.display_name ?? dragged.original_name ?? t('editor.assets')),
                    })
                  : t('editor.dropInsertFiles', { count: Math.max(n, 1) });
              setDrop({ frame, y: target.y, label, where: target.where });
            }}
            onScroll={(e) => {
              // Keep the frame on the visible area while the content scrolls under it.
              const doc = e.currentTarget;
              setDrop((d) => (d === null ? d : { ...d, frame: dropFrame(doc) }));
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDrop(null);
            }}
            onDropCapture={(e) => {
              const kind = dragKind([...e.dataTransfer.types]);
              if (kind === null) return;
              e.preventDefault();
              e.stopPropagation();
              // Where the pointer is now (the last dragover may not have rendered yet).
              const where = dropTarget(e.clientY).where;
              setDrop(null);
              if (insertBlocked !== null) return;
              if (kind === 'asset') {
                const asset = draggedAsset.current;
                draggedAsset.current = null;
                if (asset !== null) void insert?.insertAsset(asset, where);
                return;
              }
              const files = [...e.dataTransfer.files];
              const images = imageFiles(files);
              if (images.length < files.length) {
                setNotice(t('editor.onlyImages'));
              }
              void insert?.insertFiles(images, where);
            }}
          >
            {ai !== null && (
              <SelectionToolbar
                editor={editor}
                scroller={docRef}
                mode={mode}
                active={active}
                disabled={
                  readOnly ||
                  rewriteTarget !== null ||
                  rewriteState?.phase === 'loading' ||
                  rewriteState?.phase === 'busy'
                }
                imageDisabledReason={imageDisabledReason}
                onAction={onToolbar}
                onManagePrompts={() => {
                  void session.save().finally(() => onOpenPrompts?.());
                }}
                onOpenAiServices={() => {
                  void session.save().finally(() => onOpenSettings?.());
                }}
                onNotice={setOkNotice}
                onError={setNotice}
              />
            )}
            {ai !== null && mode === 'visual' && (
              <InlineAi
                editor={editor}
                scroller={docRef}
                rewrite={ai.rewrite}
                rewriteTarget={rewriteTarget}
                images={ai.images}
                layoutKey={`${state.draft.markdown.length}:${String(editorKey)}:${String(state.epoch)}`}
                active={active}
                readOnly={readOnly}
                onRewriteClosed={closeRewriteTarget}
                onNotice={setNotice}
              />
            )}
            <CoverStrip
              client={client}
              workId={work.id}
              markdown={state.saved.markdown}
              revision={state.baseRevision}
            />
            <PendingInserts
              pending={insertState.pending}
              onRetry={(key) => {
                insert?.retry(key);
              }}
              onRemove={(key) => {
                insert?.remove(key);
              }}
            />
            {drop !== null && <DropIndicator frame={drop.frame} y={drop.y} label={drop.label} />}
            <MarkdownEditor
              key={`${work.id}:${editorKey}:${state.epoch}`}
              ref={editor}
              initialMode={forcedMode.current}
              markdown={state.draft.markdown}
              readOnly={readOnly}
              resolveImage={resolveImage}
              showModeSwitch={false}
              onModeChange={setMode}
              onVisualUnavailable={() => {
                setNotice(t('editor.visualUnavailable'));
              }}
              onChange={(markdown) => {
                session.edit({ markdown });
              }}
              onCompositionChange={(composing) => {
                session.setComposing(composing);
              }}
              onSelectionChange={setSelectionRange}
              locale={locale}
            />
          </section>
        </div>
        {slashAt !== null && (
          <SlashMenu
            at={slashAt}
            commands={slashCommands}
            onClose={(ran) => {
              if (!ran) pendingWhere.current = null;
              setSlashAt(null);
            }}
          />
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            const where = takeWhere();
            if (insertBlocked === null) void insert?.insertFiles(imageFiles(files), where);
          }}
        />
      </main>
      <EditorSide
        workId={work.id}
        active={active}
        badges={{ proposals: pendingProposals }}
        inert={dialogOpen}
        panels={{
          preview: (
            <PreviewPanel
              client={client}
              work={work}
              source={{
                title: state.draft.title,
                text: state.draft.markdown,
                format: 'markdown',
                tags: state.draft.tags,
              }}
              caret={selectionRange?.start ?? null}
              resolveImage={resolveImage}
              onEditSource={(start, end) => {
                editor.current?.restoreSelection({ start, end });
              }}
              onShorten={ai === null || readOnly ? undefined : shortenAll}
              onOverLimit={onOverLimit}
              onNotice={setNotice}
            />
          ),
          ai:
            ai === null ? null : (
              <AiPanel
                providers={ai.providers}
                rewrite={ai.rewrite}
                selection={aiSelection}
                readOnly={readOnly}
                revisionNumber={(id) => numbers.get(id)}
                refreshToken={providersEpoch}
                images={ai.images}
                selectionText={
                  aiSelection.range === null
                    ? ''
                    : state.draft.markdown.slice(aiSelection.range.start, aiSelection.range.end)
                }
                insertOffset={insertOffset}
                onNotice={setNotice}
                {...(tabRequest === undefined ? {} : { tabRequest })}
                onOpenSettings={() => {
                  void session.save().finally(() => onOpenSettings?.());
                }}
                onOpenPrompts={() => {
                  void session.save().finally(() => onOpenPrompts?.());
                }}
              />
            ),
          ...(pendingProposals > 0
            ? {
                proposals: (
                  <ProposalsSideTab
                    client={client}
                    workId={work.id}
                    text={state.draft.markdown}
                    prepare={async () => {
                      await session.save();
                      const now = session.snapshot;
                      return session.hasUnsavedChanges() || now.status === 'conflict'
                        ? null
                        : now.baseRevision;
                    }}
                    onHighlight={setProposalHits}
                    onNotice={setNotice}
                  />
                ),
              }
            : {}),
          history: (
            <HistoryPanel
              client={client}
              workId={work.id}
              revisions={revisions}
              numbers={numbers}
              currentRevision={state.baseRevision}
              currentMarkdown={state.saved.markdown}
              currentTitle={state.saved.title}
              readOnly={readOnly}
              onRestore={(rid) => session.restore(rid)}
            />
          ),
          assets: (
            <AssetDrawer
              client={client}
              workId={work.id}
              disabledReason={insertBlocked}
              onInsert={(asset) => {
                void insert?.insertAsset(asset, takeWhere());
              }}
              onDragAsset={(asset) => {
                draggedAsset.current = asset;
              }}
            />
          ),
        }}
      />

      {costConfirm.node}
      {dialogOpen && (
        <ConflictDialog
          session={session}
          revisionNumber={(id) => numbers.get(id)}
          onRevisionsChanged={loadRevisions}
          onClose={() => {
            setDialogOpen(false);
            setEditorKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}

/** The `cover:` of the front matter, if any (QC-070: an article's cover). */
export function frontMatterCover(markdown: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (m === null) return null;
  const line = /^cover:\s*(.+?)\s*$/m.exec(m[1] ?? '');
  const value = line?.[1]?.replace(/^['"]|['"]$/g, '') ?? '';
  return value === '' ? null : value;
}

/**
 * 封面 at the top of an article (QC-070, PT-20261122-002): once a cover is set
 * (front-matter `cover:`), a slim strip above the text shows it. The image is
 * the work's card image (QC-061), which is the front-matter cover for an
 * article; the text itself is unchanged.
 */
function CoverStrip({
  client,
  workId,
  markdown,
  revision,
}: {
  client: CreatorHubClient;
  workId: string;
  markdown: string;
  revision: string;
}) {
  const src = frontMatterCover(markdown);
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  const key = `${src ?? ''}@${revision}`;
  useEffect(() => {
    if (src === null) return;
    let alive = true;
    void client.works.list({ ids: [workId] }).then(
      (res) => {
        const url = res.items[0]?.card_image?.url ?? null;
        if (alive && url !== null) setShown({ key, url: client.media.absoluteUrl(url) });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client, workId, src, key]);
  if (src === null || shown === null) return null;
  return (
    <figure className="cover-strip">
      <img className="cover-strip__img" src={shown.url} alt="" />
      <figcaption className="cover-strip__label">
        {t('ai.coverLabel')}
        <span className="cover-strip__src mono">{src}</span>
      </figcaption>
    </figure>
  );
}
