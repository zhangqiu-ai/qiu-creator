import type { CreatorHubClient } from '@qiu-creator/api-client';
import type {
  ProposalCountsResponse,
  ProposalDetail,
  ProposalHunk,
  ProposalStatus,
} from '@qiu-creator/contracts';
import { t } from './i18n.js';

/**
 * Agent proposals in the app (QC-091, PT-20261124-001): the pending counts
 * for the sidebar badge and the editor's 提案 tab, and the pure rules of
 * the inbox (which changes can be accepted, where a change sits in the
 * text). Framework-free for tests.
 */

export interface ProposalCounts {
  pending: number;
  byWork: Readonly<Record<string, number>>;
}

const EMPTY: ProposalCounts = { pending: 0, byWork: {} };

/** Pending proposal counts, refreshed on `proposal.*` events. */
export class ProposalCountsStore {
  private counts: ProposalCounts = EMPTY;
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  constructor(private readonly load: () => Promise<ProposalCountsResponse>) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ProposalCounts => this.counts;

  /** Ask the service again; an older answer arriving late never wins. */
  refresh(): Promise<void> {
    const seq = ++this.seq;
    return this.load().then(
      (res) => {
        if (seq !== this.seq) return;
        this.counts = { pending: res.pending, byWork: res.by_work };
        for (const l of this.listeners) l();
      },
      () => undefined,
    );
  }
}

export function countsStore(client: CreatorHubClient): ProposalCountsStore {
  return new ProposalCountsStore(() => client.proposals.counts());
}

/** Is this change event about proposals (the badge and lists then refresh)? */
export function isProposalEvent(action: string): boolean {
  return action.startsWith('proposal.');
}

/** Lines added and removed by a proposal (`+3 −1`). */
export function lineStats(hunks: readonly ProposalHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.added.length;
    removed += h.removed.length;
  }
  return { added, removed };
}

/** The changes picked by default: all of them, except those overlapping later edits. */
export function defaultPicks(detail: Pick<ProposalDetail, 'hunks'>): Set<string> {
  return new Set(detail.hunks.filter((h) => h.overlap !== 'conflict').map((h) => h.id));
}

/**
 * Why 採用 is off, or null when it can be pressed: nothing picked, the
 * proposal is decided, or a picked change overlaps later edits (those need
 * the three-way comparison first; PT-20261124-001 decision 3).
 */
export function acceptBlock(
  detail: Pick<ProposalDetail, 'status' | 'hunks'>,
  picked: ReadonlySet<string>,
): 'decided' | 'none' | 'conflict' | null {
  if (detail.status !== 'pending') return 'decided';
  if (picked.size === 0) return 'none';
  if (detail.hunks.some((h) => picked.has(h.id) && h.overlap === 'conflict')) return 'conflict';
  return null;
}

/** The request: all changes (no `hunk_ids`) when every one is picked. */
export function acceptInput(
  detail: Pick<ProposalDetail, 'hunks' | 'current_revision'>,
  picked: ReadonlySet<string>,
): { base_revision: string; hunk_ids?: string[] } {
  const ids = detail.hunks.filter((h) => picked.has(h.id)).map((h) => h.id);
  return ids.length === detail.hunks.length
    ? { base_revision: detail.current_revision }
    : { base_revision: detail.current_revision, hunk_ids: ids };
}

/** Character offsets of base lines `[from, to)` in `text` (0-based line numbers). */
export function lineRange(text: string, from: number, to: number): { start: number; end: number } {
  const lines = text.split('\n');
  let start = 0;
  for (let i = 0; i < from && i < lines.length; i++) start += (lines[i]?.length ?? 0) + 1;
  let end = start;
  for (let i = from; i < to && i < lines.length; i++) end += (lines[i]?.length ?? 0) + 1;
  return {
    start: Math.min(start, text.length),
    end: Math.max(start, Math.min(end - 1, text.length)),
  };
}

/**
 * Where a change sits in the work's text now, to highlight it in the
 * editor. With the work still at the proposal's base, by line; otherwise
 * by finding the lines it replaces (or, for an insertion, the line before).
 * Null when the place cannot be found.
 */
export function hunkPlace(
  current: string,
  base: string,
  hunk: Pick<ProposalHunk, 'base_start' | 'base_end' | 'removed'>,
): { start: number; end: number } | null {
  const anchorFrom = hunk.removed.length > 0 ? hunk.base_start : Math.max(0, hunk.base_start - 1);
  const anchorTo = hunk.removed.length > 0 ? hunk.base_end : anchorFrom + 1;
  if (current === base) return lineRange(base, anchorFrom, anchorTo);
  const baseLines = base.split('\n');
  const needle = baseLines.slice(anchorFrom, anchorTo).join('\n');
  if (needle.trim() === '') return null;
  const at = current.indexOf(needle);
  if (at < 0 || current.indexOf(needle, at + 1) >= 0) return null;
  return { start: at, end: at + needle.length };
}

/** `r12` for a revision id, from the work's revision numbers. */
export function revName(numbers: ReadonlyMap<string, number>, id: string): string {
  const n = numbers.get(id);
  return n === undefined ? id.slice(0, 8) : `r${String(n)}`;
}

/**
 * Two letters for an agent's avatar: the initials of two Latin words
 * (`Claude Code` → `CC`), else the first two letters of a Latin name
 * (`Obsidian 同步` → `OB`, `codex` → `CO`), else its first character.
 */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  const latin = (w: string | undefined): boolean => w !== undefined && /^[A-Za-z0-9]/.test(w);
  const first = words[0] ?? '';
  const letters =
    latin(first) && latin(words[1])
      ? `${first.charAt(0)}${(words[1] ?? '').charAt(0)}`
      : latin(first)
        ? first.slice(0, 2)
        : (Array.from(first)[0] ?? '');
  return letters.toUpperCase() || '?';
}

/** A steady avatar colour per agent name (one of eight). */
export function avatarTone(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % 8;
}

export function statusLabel(status: ProposalStatus): string {
  switch (status) {
    case 'accepted':
      return t('agents.statusAccepted');
    case 'partially_accepted':
      return t('agents.statusPartial');
    case 'discarded':
      return t('agents.statusDiscarded');
    case 'pending':
      return t('agents.tabPending');
  }
}
