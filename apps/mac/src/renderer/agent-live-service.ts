import type { CreatorHubClient } from '@qiu-creator/api-client';
import type {
  AgentActivity,
  AgentActivityCounts,
  AgentActivityEvent,
} from '@qiu-creator/contracts';
import type { EventStreamStatus } from '../shared/bridge.js';
import type { LiveSource, LiveState, SourceCounts, WorkLiveRecord } from './agent-live.js';

/**
 * The live agent status from the service (QC-096) as a {@link LiveSource}
 * (QC-097): the current entries from `GET /api/v1/agents/activity`, kept up
 * to date by `agent.activity` events on the change stream, and read again
 * after every reconnect (those events are never replayed). Entries come per
 * (agent, work); the screens want one record per work.
 */

/** Which state a work shows when its agents differ: what needs you first, then work in progress. */
const RANK: Readonly<Record<LiveState, number>> = {
  error: 5,
  needs_attention: 4,
  working: 3,
  stale: 2,
  done: 1,
  idle: 0,
};

const key = (a: Pick<AgentActivity, 'token_id' | 'work_id'>): string =>
  `${a.token_id}\u0000${a.work_id}`;

const time = (at: string | null): number => (at === null ? 0 : Date.parse(at) || 0);

/**
 * One record per work from the service's per-(agent, work) entries: the
 * highest-ranked state, the agents in that state (most recent first), the
 * most recent step among them, and the latest of their times. Titles and
 * projects come from `works` when known.
 */
export function groupActivity(
  entries: readonly AgentActivity[],
  works: ReadonlyMap<string, { title: string; project_ids: readonly string[] }>,
  now: string,
): WorkLiveRecord[] {
  const byWork = new Map<string, AgentActivity[]>();
  for (const e of entries) {
    if (e.state === 'idle') continue;
    const list = byWork.get(e.work_id) ?? [];
    list.push(e);
    byWork.set(e.work_id, list);
  }
  const out: WorkLiveRecord[] = [];
  for (const [workId, list] of byWork) {
    const top = Math.max(...list.map((e) => RANK[e.state]));
    const shown = list
      .filter((e) => RANK[e.state] === top)
      .sort((a, b) => time(b.last_active_at) - time(a.last_active_at));
    const lead = shown[0];
    if (lead === undefined) continue;
    const work = works.get(workId);
    const expiries = shown.map((e) => e.expires_at).filter((x): x is string => x !== null);
    out.push({
      work_id: workId,
      ...(work === undefined ? {} : { work_title: work.title, project_ids: work.project_ids }),
      state: lead.state,
      agents: shown.map((e) => ({ token_id: e.token_id, name: e.agent_name })),
      step: shown.find((e) => e.step !== null)?.step ?? null,
      updated_at: lead.last_active_at ?? now,
      server: true,
      // A work's done lasts while any of its agents' done does.
      expires_at:
        expiries.length === shown.length && expiries.length > 0
          ? expiries.reduce((a, b) => (time(a) >= time(b) ? a : b))
          : null,
    });
  }
  return out;
}

/** The service's sidebar counts in the screens' terms. */
export function countsOf(counts: AgentActivityCounts): SourceCounts {
  const byProject: Record<string, number> = {};
  for (const p of counts.projects) if (p.agents > 0) byProject[p.project_id] = p.agents;
  return { working: counts.all.agents, workingWorks: counts.all.works, byProject };
}

export interface ActivityFeed {
  onAgentActivity: (listener: (event: AgentActivityEvent) => void) => () => void;
  onEventStatus: (listener: (status: EventStreamStatus) => void) => () => void;
}

export class ServiceLiveSource implements LiveSource {
  private readonly entries = new Map<string, AgentActivity>();
  private serverCounts: SourceCounts | null = null;
  private now = new Date().toISOString();
  private readonly works = new Map<string, { title: string; project_ids: readonly string[] }>();
  private readonly asked = new Set<string>();
  private loaded = false;
  private fetching: Promise<void> | null = null;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly feed: ActivityFeed,
  ) {}

  async load(): Promise<readonly WorkLiveRecord[]> {
    if (!this.loaded) await this.fetch();
    return groupActivity([...this.entries.values()], this.works, this.now);
  }

  counts(): SourceCounts | null {
    return this.serverCounts;
  }

  watch(onChange: () => void): () => void {
    let wasOpen: boolean | null = null;
    const offActivity = this.feed.onAgentActivity((event) => {
      if (event.activity.state === 'idle') this.entries.delete(key(event.activity));
      else this.entries.set(key(event.activity), event.activity);
      this.serverCounts = countsOf(event.counts);
      this.now = event.at;
      this.lookUpWorks(onChange);
      onChange();
    });
    // Back from a dropped stream: nothing was replayed, so read the state again.
    const offStatus = this.feed.onEventStatus((status) => {
      const open = status === 'open';
      if (open && wasOpen === false) {
        this.loaded = false;
        void this.fetch().then(onChange);
      }
      wasOpen = open;
    });
    return () => {
      offActivity();
      offStatus();
    };
  }

  private fetch(): Promise<void> {
    if (this.fetching !== null) return this.fetching;
    const run = this.client.agents
      .activity()
      .then(async (res) => {
        this.entries.clear();
        for (const a of res.items) this.entries.set(key(a), a);
        this.serverCounts = countsOf(res.counts);
        this.now = res.now;
        this.loaded = true;
        await this.lookUpWorksNow();
      })
      .catch(() => {
        // Offline or an older service: show nothing until the stream speaks.
        this.loaded = true;
      })
      .finally(() => {
        this.fetching = null;
      });
    this.fetching = run;
    return run;
  }

  /** Titles and projects of works the entries name (for the popover and project counts). */
  private lookUpWorks(onChange: () => void): void {
    void this.lookUpWorksNow().then((found) => {
      if (found) onChange();
    });
  }

  private async lookUpWorksNow(): Promise<boolean> {
    const ids = [...new Set([...this.entries.values()].map((e) => e.work_id))].filter(
      (id) => !this.asked.has(id),
    );
    if (ids.length === 0) return false;
    for (const id of ids) this.asked.add(id);
    try {
      const res = await this.client.works.list({ ids, limit: Math.min(200, ids.length) });
      for (const w of res.items) {
        this.works.set(w.id, { title: w.title, project_ids: w.project_ids ?? [] });
      }
      return res.items.length > 0;
    } catch {
      for (const id of ids) this.asked.delete(id);
      return false;
    }
  }
}
