import { EventEmitter } from 'node:events';
import {
  AGENT_ACTIVITY_EVENT,
  AGENT_DONE_HOLD_SECONDS,
  AGENT_IDLE_AFTER_SECONDS,
  AGENT_STALE_AFTER_SECONDS,
  AGENT_STEP_MAX_CHARS,
  AGENT_WORKING_WINDOW_SECONDS,
  type AgentActivity,
  type AgentActivityCounts,
  type AgentActivityEvent,
  type AgentActivityReason,
  type AgentActivityState,
  type AgentReportState,
  type ChangeEvent,
} from '@qiu-creator/contracts';
import type { Db } from '../db/database.js';
import type { ChangeFeed } from '../events/change-feed.js';

/**
 * Agent live status (QC-096, PT-20261125-001, decisions 2026-11-25).
 *
 * Per (agent token, work), in memory:
 * - operations: every change event an agent token caused on a work (writes,
 *   proposals, imports into the work), taken from the change feed, so no
 *   route list has to be kept in sync;
 * - reports: `POST /api/v1/agents/status` (`agent_status_report`);
 * - failed imports the agent started for the work, until retried or done.
 * Pending proposals come from the database, so they survive a restart; the
 * rest starts idle again after one (accepted in the task).
 *
 * The state at a given time (first rule that applies):
 * 1. a valid report, unless it is done / needs_attention / error and an
 *    operation came after it;
 * 2. an operation in the last 60 s → working;
 * 3. a failed import → error;
 * 4. a pending proposal → needs_attention;
 * 5. the last operation or working report less than 2 min ago → working;
 * 6. less than 10 min ago → stale;
 * 7. idle.
 * A done, needs_attention or error report ends the work before it: older
 * operations no longer count towards working or stale. A working report
 * that lapses is measured from when it was made, so a crashed agent goes
 * stale (or idle) as soon as its TTL ends.
 */

export const WORKING_WINDOW_MS = AGENT_WORKING_WINDOW_SECONDS * 1000;
export const STALE_AFTER_MS = AGENT_STALE_AFTER_SECONDS * 1000;
export const IDLE_AFTER_MS = AGENT_IDLE_AFTER_SECONDS * 1000;
export const DONE_HOLD_MS = AGENT_DONE_HOLD_SECONDS * 1000;

interface Report {
  state: AgentReportState;
  step: string | null;
  at: number;
  until: number;
}

interface Entry {
  tokenId: string;
  workId: string;
  lastOpAt: number | null;
  report: Report | null;
  /** Operations at or before this no longer count (after a done/attention/error report). */
  settledAt: number;
  failedJobs: Set<string>;
}

interface Evaluated {
  state: AgentActivityState;
  reason: AgentActivityReason;
  step: string | null;
  lastActiveAt: number | null;
  expiresAt: number | null;
}

export interface AgentActivityOptions {
  now?: () => number;
  /** Re-evaluate on a timer when a state lapses (default true; tests call `tick()`). */
  timers?: boolean;
}

const key = (tokenId: string, workId: string): string => `${tokenId}:${workId}`;
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const URL_LIKE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/giu;
const MD_LINK = /!?\[([^\]]*)\]\([^)]*\)/gu;
const TAG = /<[^>]*>/gu;
const PATH_LIKE = /(?:^|\s)(?:~|\.{0,2})\/\S*/gu;
const MARKUP = /[<>[\](){}*_`#~|\\=]/gu;

/**
 * An agent's step, made safe to show as plain data: control and format
 * characters, links, Markdown and HTML markup and file paths are removed,
 * whitespace collapsed, and the result cut to 24 characters. Empty → null.
 */
export function cleanStep(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = raw
    .replace(CONTROL, ' ')
    .replace(MD_LINK, '$1')
    .replace(TAG, ' ')
    .replace(URL_LIKE, ' ')
    .replace(PATH_LIKE, ' ')
    .replace(MARKUP, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text === '') return null;
  const chars = Array.from(text);
  return chars.length <= AGENT_STEP_MAX_CHARS
    ? text
    : `${chars.slice(0, AGENT_STEP_MAX_CHARS - 1).join('')}…`;
}

export class AgentActivityService {
  private readonly entries = new Map<string, Entry>();
  /** What was last published per pair, to send only changes. */
  private readonly published = new Map<string, Evaluated>();
  private readonly emitter = new EventEmitter();
  private readonly now: () => number;
  private readonly useTimers: boolean;
  private timer: NodeJS.Timeout | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly db: Db,
    feed: ChangeFeed,
    options: AgentActivityOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.useTimers = options.timers ?? true;
    this.emitter.setMaxListeners(0);
    this.unsubscribe = feed.subscribe((event) => {
      this.onChange(event);
    });
  }

  close(): void {
    this.unsubscribe();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.emitter.removeAllListeners();
  }

  /** `agent.activity` events for SSE; returns the unsubscribe function. */
  subscribe(listener: (event: AgentActivityEvent) => void): () => void {
    this.emitter.on(AGENT_ACTIVITY_EVENT, listener);
    return () => this.emitter.off(AGENT_ACTIVITY_EVENT, listener);
  }

  /** An agent's report on works it may touch (the route checked them). */
  report(
    tokenId: string,
    workIds: readonly string[],
    input: { state: AgentReportState; step?: string; ttl_seconds: number },
  ): AgentActivity[] {
    const at = this.now();
    const step = cleanStep(input.step);
    const until = at + (input.state === 'done' ? DONE_HOLD_MS : input.ttl_seconds * 1000);
    for (const workId of workIds) {
      const entry = this.entry(tokenId, workId);
      entry.report = {
        state: input.state,
        // Steps describe work in progress; done/attention/error show their own label.
        step: input.state === 'working' ? step : null,
        at,
        until,
      };
      if (input.state !== 'working') entry.settledAt = at;
    }
    this.refresh();
    return workIds.map((workId) => this.activityOf(this.entry(tokenId, workId), at));
  }

  /** Non-idle entries, optionally only for some works, plus the sidebar counts. */
  list(workIds?: readonly string[]): { items: AgentActivity[]; counts: AgentActivityCounts } {
    const now = this.now();
    const only = workIds === undefined ? null : new Set(workIds);
    const items = this.all(now)
      .filter(([entry, ev]) => ev.state !== 'idle' && (only === null || only.has(entry.workId)))
      .map(([entry, ev]) => this.toActivity(entry, ev));
    return { items, counts: this.counts(now) };
  }

  /** Re-evaluate everything at the current time and publish what changed. */
  tick(): void {
    this.refresh();
  }

  // ---- inputs ----------------------------------------------------------------

  private onChange(event: ChangeEvent): void {
    const actor = event.actor ?? null;
    if (event.entity === 'work') {
      if (actor !== null && actor !== 'owner') {
        this.entry(actor, event.entity_id).lastOpAt = this.now();
      }
      // A proposal decided by the user changes needs_attention for its agent.
      this.refresh();
      return;
    }
    if (event.entity === 'job' && event.data['type'] === 'import') {
      this.onImportJob(event, actor);
    }
  }

  private onImportJob(event: ChangeEvent, actor: string | null): void {
    const job = this.importJob(event.entity_id);
    if (job === null) return;
    const entry = this.entry(job.agent, job.workId);
    if (event.action === 'job.queued') {
      // Queued (or retried) by the agent itself: an operation, and the old failure is handled.
      if (actor === job.agent) entry.lastOpAt = this.now();
      entry.failedJobs.delete(event.entity_id);
    } else if (event.action === 'job.failed') {
      entry.failedJobs.add(event.entity_id);
    } else if (event.action === 'job.succeeded') {
      entry.failedJobs.delete(event.entity_id);
    }
    this.refresh();
  }

  /** An import an agent token started for a work (`created_by`, `link_work_id`), else null. */
  private importJob(jobId: string): { workId: string; agent: string } | null {
    const row = this.db
      .prepare<[string], { link_work_id: string | null; created_by: string | null }>(
        'SELECT link_work_id, created_by FROM import_jobs WHERE id = ?',
      )
      .get(jobId);
    if (row?.link_work_id == null || row.created_by == null || row.created_by === 'owner') {
      return null;
    }
    return { workId: row.link_work_id, agent: row.created_by };
  }

  // ---- evaluation --------------------------------------------------------------

  private entry(tokenId: string, workId: string): Entry {
    const k = key(tokenId, workId);
    let entry = this.entries.get(k);
    if (entry === undefined) {
      entry = {
        tokenId,
        workId,
        lastOpAt: null,
        report: null,
        settledAt: 0,
        failedJobs: new Set(),
      };
      this.entries.set(k, entry);
    }
    return entry;
  }

  /** Pairs with a pending proposal, as `token:work` keys. */
  private pendingPairs(): Set<string> {
    const rows = this.db
      .prepare<[], { token_id: string; work_id: string }>(
        `SELECT DISTINCT p.token_id, p.work_id FROM proposals p
         JOIN works w ON w.id = p.work_id
         WHERE p.status = 'pending' AND w.deleted_at IS NULL`,
      )
      .all();
    return new Set(rows.map((r) => key(r.token_id, r.work_id)));
  }

  private evaluate(entry: Entry, now: number, pending: boolean): Evaluated {
    const op = entry.lastOpAt !== null && entry.lastOpAt > entry.settledAt ? entry.lastOpAt : null;
    const r = entry.report;
    const lastActiveAt = Math.max(op ?? 0, r?.at ?? 0) || null;
    if (r !== null && now < r.until && (r.state === 'working' || op === null || op <= r.at)) {
      return { state: r.state, reason: 'report', step: r.step, lastActiveAt, expiresAt: r.until };
    }
    if (op !== null && now - op < WORKING_WINDOW_MS) {
      return {
        state: 'working',
        reason: 'operation',
        step: null,
        lastActiveAt,
        expiresAt: op + WORKING_WINDOW_MS,
      };
    }
    if (entry.failedJobs.size > 0) {
      return { state: 'error', reason: 'job_failed', step: null, lastActiveAt, expiresAt: null };
    }
    if (pending) {
      return {
        state: 'needs_attention',
        reason: 'proposal_pending',
        step: null,
        lastActiveAt,
        expiresAt: null,
      };
    }
    const workingReport = r !== null && r.state === 'working' && r.at > entry.settledAt ? r.at : 0;
    const signal = Math.max(op ?? 0, workingReport);
    if (signal > 0 && now - signal < STALE_AFTER_MS) {
      return {
        state: 'working',
        reason: op !== null && op >= workingReport ? 'operation' : 'report',
        step: null,
        lastActiveAt,
        expiresAt: signal + STALE_AFTER_MS,
      };
    }
    if (signal > 0 && now - signal < IDLE_AFTER_MS) {
      return {
        state: 'stale',
        reason: 'none',
        step: null,
        lastActiveAt,
        expiresAt: signal + IDLE_AFTER_MS,
      };
    }
    return { state: 'idle', reason: 'none', step: null, lastActiveAt, expiresAt: null };
  }

  /** Every known pair (plus pending-proposal pairs not seen since start) with its state. */
  private all(now: number): [Entry, Evaluated][] {
    const pending = this.pendingPairs();
    for (const k of pending) {
      if (!this.entries.has(k)) {
        const [tokenId = '', workId = ''] = k.split(':');
        this.entry(tokenId, workId);
      }
    }
    const names = this.tokenNames();
    const out: [Entry, Evaluated][] = [];
    for (const [k, entry] of this.entries) {
      if (!names.has(entry.tokenId)) {
        // Revoked or deleted token: nothing to show.
        this.entries.delete(k);
        continue;
      }
      out.push([entry, this.evaluate(entry, now, pending.has(k))]);
    }
    return out;
  }

  private names: Map<string, string> = new Map();

  /** Live agent tokens' names (revoked tokens are left out). */
  private tokenNames(): Map<string, string> {
    const rows = this.db
      .prepare<[], { id: string; name: string }>(
        'SELECT id, name FROM api_tokens WHERE revoked_at IS NULL',
      )
      .all();
    this.names = new Map(rows.map((r) => [r.id, r.name]));
    return this.names;
  }

  private toActivity(entry: Entry, ev: Evaluated): AgentActivity {
    return {
      token_id: entry.tokenId,
      agent_name: this.names.get(entry.tokenId) ?? '',
      work_id: entry.workId,
      state: ev.state,
      reason: ev.reason,
      step: ev.step,
      last_active_at: iso(ev.lastActiveAt),
      expires_at: iso(ev.expiresAt),
    };
  }

  private activityOf(entry: Entry, now: number): AgentActivity {
    this.tokenNames();
    return this.toActivity(
      entry,
      this.evaluate(entry, now, this.pendingPairs().has(key(entry.tokenId, entry.workId))),
    );
  }

  private counts(now: number, evaluated = this.all(now)): AgentActivityCounts {
    const working = evaluated.filter(([, ev]) => ev.state === 'working').map(([e]) => e);
    const all = {
      agents: new Set(working.map((e) => e.tokenId)).size,
      works: new Set(working.map((e) => e.workId)).size,
    };
    if (working.length === 0) return { all, projects: [] };
    const workIds = [...new Set(working.map((e) => e.workId))];
    const rows = this.db
      .prepare<[string], { work_id: string; project_id: string }>(
        `SELECT wp.work_id, wp.project_id FROM work_projects wp
         JOIN projects p ON p.id = wp.project_id
         WHERE wp.work_id IN (SELECT value FROM json_each(?)) AND p.deleted_at IS NULL`,
      )
      .all(JSON.stringify(workIds));
    const byProject = new Map<string, { agents: Set<string>; works: Set<string> }>();
    for (const row of rows) {
      let p = byProject.get(row.project_id);
      if (p === undefined) {
        p = { agents: new Set(), works: new Set() };
        byProject.set(row.project_id, p);
      }
      for (const e of working) {
        if (e.workId !== row.work_id) continue;
        p.agents.add(e.tokenId);
        p.works.add(e.workId);
      }
    }
    const projects = [...byProject]
      .map(([project_id, p]) => ({ project_id, agents: p.agents.size, works: p.works.size }))
      .sort((a, b) => a.project_id.localeCompare(b.project_id));
    return { all, projects };
  }

  /** Publish changed entries, drop idle ones, and arm the timer for the next lapse. */
  private refresh(): void {
    const now = this.now();
    const evaluated = this.all(now);
    const changed: [Entry, Evaluated][] = [];
    let next: number | null = null;
    for (const [entry, ev] of evaluated) {
      const k = key(entry.tokenId, entry.workId);
      const before = this.published.get(k);
      const same =
        before !== undefined &&
        before.state === ev.state &&
        before.reason === ev.reason &&
        before.step === ev.step &&
        before.expiresAt === ev.expiresAt;
      if (!same && !(before === undefined && ev.state === 'idle')) changed.push([entry, ev]);
      if (ev.state === 'idle') {
        this.published.delete(k);
        if (entry.failedJobs.size === 0) this.entries.delete(k);
      } else {
        this.published.set(k, ev);
      }
      if (ev.expiresAt !== null && (next === null || ev.expiresAt < next)) next = ev.expiresAt;
    }
    if (changed.length > 0) {
      const counts = this.counts(now, evaluated);
      const at = new Date(now).toISOString();
      for (const [entry, ev] of changed) {
        const event: AgentActivityEvent = {
          type: AGENT_ACTIVITY_EVENT,
          activity: this.toActivity(entry, ev),
          counts,
          at,
        };
        this.emitter.emit(AGENT_ACTIVITY_EVENT, event);
      }
    }
    this.arm(next, now);
  }

  private arm(next: number | null, now: number): void {
    if (!this.useTimers) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (next === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.refresh();
      },
      Math.max(0, next - now) + 5,
    );
    this.timer.unref();
  }
}
