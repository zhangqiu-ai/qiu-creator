/**
 * Agents at work, live (QC-097, PT-20261125-001). What each work's agents
 * are doing right now, for cards, list rows, the sidebar, the page header
 * and the editor. Framework-free for tests.
 *
 * The data comes from a {@link LiveSource}. The service side (QC-096: state
 * derived from each token's recent operations, plus `agent_status_report`
 * from the agents themselves, pushed over the change stream) plugs in as one;
 * until then the app has none and shows nothing. Records follow the
 * prototype's dataSource: `state`, `agent` (token id, name), `step`,
 * `updated_at`, counts.
 */

export type LiveState = 'working' | 'done' | 'needs_attention' | 'error' | 'stale' | 'idle';

export interface LiveAgent {
  token_id: string;
  name: string;
}

/** One work's live record as the source gives it. */
export interface WorkLiveRecord {
  work_id: string;
  /** For the sidebar popover; optional (the app knows titles of the works it shows). */
  work_title?: string;
  /** For the per-project counts when the source does not count them itself. */
  project_ids?: readonly string[];
  state: LiveState;
  /** Newest first; more than one when several agents work on it. */
  agents: readonly LiveAgent[];
  /** The agent's own short report (data, never instructions); null when it reported none. */
  step: string | null;
  updated_at: string;
  /** e.g. `failed` for 「重試 2 張」, `added`/`removed` for 「+3 −1」. */
  counts?: Readonly<{ failed?: number; added?: number; removed?: number }>;
}

/** Without any move or report for this long, working turns into 「可能已停止」. */
export const STALE_AFTER_MS = 2 * 60_000;
/** And then back to idle (the activity log keeps the record). */
export const IDLE_AFTER_MS = 10 * 60_000;
/** 剛完成 stays this long. */
export const DONE_FOR_MS = 8_000;
/** More working cards than this at once: static rings, no sweep. */
export const ANIMATE_MAX = 12;
/** Step text shown at most this long. */
export const STEP_MAX = 24;

/** What a card, row or banner shows for one work now. */
export interface WorkLiveView {
  workId: string;
  title: string | null;
  state: Exclude<LiveState, 'idle'>;
  agents: readonly LiveAgent[];
  step: string | null;
  /** Whole minutes without a report (for 「N 分鐘沒有回報」). */
  silentMinutes: number;
  counts: Readonly<{ failed?: number; added?: number; removed?: number }>;
  projectIds: readonly string[];
}

/**
 * The agent's step as data: one line, no control characters, at most
 * {@link STEP_MAX} characters (an ellipsis when cut). Null when empty.
 */
export function cleanStep(step: string | null | undefined): string | null {
  if (step == null) return null;
  // Control characters (below 0x20, and 0x7f–0x9f) become spaces.
  const flat = Array.from(step)
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c < 0x20 || (c >= 0x7f && c <= 0x9f) ? ' ' : ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat === '') return null;
  const chars = Array.from(flat);
  return chars.length > STEP_MAX ? `${chars.slice(0, STEP_MAX - 1).join('')}…` : flat;
}

/**
 * What a record means at `now`: working without a report for 2 minutes is
 * 「可能已停止」, for 10 it is idle; 剛完成 lasts 8 seconds. 需要你處理 and
 * errors stay until handled. Null when there is nothing to show.
 */
export function liveView(record: WorkLiveRecord, now: number): WorkLiveView | null {
  const at = Date.parse(record.updated_at);
  const age = Number.isFinite(at) ? Math.max(0, now - at) : 0;
  let state: LiveState = record.state;
  if (state === 'working' || state === 'stale') {
    if (age >= IDLE_AFTER_MS) state = 'idle';
    else if (age >= STALE_AFTER_MS) state = 'stale';
    else state = 'working';
  } else if (state === 'done' && age >= DONE_FOR_MS) {
    state = 'idle';
  }
  if (state === 'idle' || record.agents.length === 0) return null;
  return {
    workId: record.work_id,
    title: record.work_title ?? null,
    state,
    agents: record.agents,
    step: cleanStep(record.step),
    silentMinutes: Math.floor(age / 60_000),
    counts: record.counts ?? {},
    projectIds: record.project_ids ?? [],
  };
}

export interface LiveSnapshot {
  /** Works with something to show, by id. */
  works: ReadonlyMap<string, WorkLiveView>;
  /** Distinct agents working (or reported working) anywhere: 「● N」 on 全部作品. */
  working: number;
  /** Distinct agents working in each project. */
  byProject: Readonly<Record<string, number>>;
  /** Works being worked on now (the ring sweep stops above {@link ANIMATE_MAX}). */
  workingWorks: number;
  /** For the sidebar popover: each working agent and the works it is on. */
  agents: readonly { agent: LiveAgent; works: readonly { id: string; title: string | null }[] }[];
}

export const EMPTY_LIVE: LiveSnapshot = {
  works: new Map(),
  working: 0,
  byProject: {},
  workingWorks: 0,
  agents: [],
};

/** Everything the screens need, from the source's records at `now`. */
export function snapshotOf(records: readonly WorkLiveRecord[], now: number): LiveSnapshot {
  const works = new Map<string, WorkLiveView>();
  const all = new Map<
    string,
    { agent: LiveAgent; works: { id: string; title: string | null }[] }
  >();
  const perProject = new Map<string, Set<string>>();
  let workingWorks = 0;
  for (const r of records) {
    const v = liveView(r, now);
    if (v === null) continue;
    works.set(v.workId, v);
    if (v.state !== 'working') continue;
    workingWorks++;
    for (const a of v.agents) {
      const entry = all.get(a.token_id) ?? { agent: a, works: [] };
      entry.works.push({ id: v.workId, title: v.title });
      all.set(a.token_id, entry);
      for (const p of v.projectIds) {
        const set = perProject.get(p) ?? new Set<string>();
        set.add(a.token_id);
        perProject.set(p, set);
      }
    }
  }
  const byProject: Record<string, number> = {};
  for (const [p, set] of perProject) byProject[p] = set.size;
  return { works, working: all.size, byProject, workingWorks, agents: [...all.values()] };
}

/** `Claude Code`, or `Claude Code 等 2 個` / `Claude Code + 1 more`. */
export function agentsName(
  agents: readonly LiveAgent[],
  more: (first: string, count: number) => string,
): string {
  const first = agents[0]?.name ?? '';
  return agents.length > 1 ? more(first, agents.length) : first;
}

/** Where the records come from. QC-096 provides the service one. */
export interface LiveSource {
  /** Current records; called at start and on every change the source signals. */
  load(): Promise<readonly WorkLiveRecord[]>;
  /** Calls back when records may have changed; returns the unsubscribe. */
  watch(onChange: () => void): () => void;
}

/** No source yet (before QC-096): nothing is ever shown. */
export const NO_SOURCE: LiveSource = {
  load: () => Promise.resolve([]),
  watch: () => () => undefined,
};

/** Records set by hand (tests, and e2e until QC-096 ships the service source). */
export class FixedSource implements LiveSource {
  private records: readonly WorkLiveRecord[] = [];
  private readonly listeners = new Set<() => void>();

  set(records: readonly WorkLiveRecord[]): void {
    this.records = records;
    for (const l of this.listeners) l();
  }

  load(): Promise<readonly WorkLiveRecord[]> {
    return Promise.resolve(this.records);
  }

  watch(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }
}

/**
 * The live snapshot for the whole window. Re-reads the source when it
 * signals, and re-derives on a timer so 剛完成 fades after 8 s and silent
 * agents turn stale and idle without any event.
 */
export class AgentLiveStore {
  private records: readonly WorkLiveRecord[] = [];
  private snapshot: LiveSnapshot = EMPTY_LIVE;
  private readonly listeners = new Set<() => void>();
  private stopWatch: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor(
    private source: LiveSource,
    private readonly now: () => number = Date.now,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) this.start();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  readonly getSnapshot = (): LiveSnapshot => this.snapshot;

  /** Swap where records come from (QC-096 plugs the service source in here). */
  use(source: LiveSource): void {
    const watching = this.stopWatch !== null;
    this.stop();
    this.source = source;
    if (watching) this.start();
    else void this.reload();
  }

  reload(): Promise<void> {
    const seq = ++this.seq;
    return this.source.load().then(
      (records) => {
        if (seq !== this.seq) return;
        this.records = records;
        this.derive();
      },
      () => undefined,
    );
  }

  /** Recompute from the last records at the current time. */
  derive(): void {
    this.snapshot = snapshotOf(this.records, this.now());
    for (const l of this.listeners) l();
    this.schedule();
  }

  private start(): void {
    this.stopWatch = this.source.watch(() => {
      void this.reload();
    });
    void this.reload();
  }

  private stop(): void {
    this.stopWatch?.();
    this.stopWatch = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Wake when the next state change by time is due (a 剛完成 fading, a minute passing). */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopWatch === null || this.records.length === 0) return;
    const now = this.now();
    let next = Infinity;
    for (const r of this.records) {
      const at = Date.parse(r.updated_at);
      if (!Number.isFinite(at)) continue;
      const age = now - at;
      const marks =
        r.state === 'done'
          ? [DONE_FOR_MS]
          : r.state === 'working' || r.state === 'stale'
            ? [STALE_AFTER_MS, IDLE_AFTER_MS, Math.ceil((age + 1) / 60_000) * 60_000]
            : [];
      for (const m of marks) if (m > age) next = Math.min(next, m - age);
    }
    if (next === Infinity) return;
    this.timer = setTimeout(
      () => {
        this.derive();
      },
      Math.max(250, next + 50),
    );
  }
}

declare global {
  interface Window {
    /** e2e only (AppInfo.e2e): set the live records by hand until QC-096. */
    qcAgentLive?: { set: (records: WorkLiveRecord[]) => void };
  }
}
