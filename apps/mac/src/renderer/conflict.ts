import { diffLines } from './diff.js';

export type Side = 'mine' | 'server';

/** One place where my draft and the server version disagree. */
export interface Hunk {
  index: number;
  /** Lines only in the server version (empty when I added lines it lacks). */
  server: readonly string[];
  /** Lines only in my draft (empty when I deleted lines it has). */
  mine: readonly string[];
}

type Segment = { kind: 'same'; line: string } | { kind: 'hunk'; hunk: Hunk };

function segments(server: string, mine: string): Segment[] {
  const out: Segment[] = [];
  let count = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    if (removed.length === 0 && added.length === 0) return;
    out.push({ kind: 'hunk', hunk: { index: count++, server: removed, mine: added } });
    removed = [];
    added = [];
  };
  for (const d of diffLines(server, mine)) {
    if (d.kind === 'same') {
      flush();
      out.push({ kind: 'same', line: d.text });
    } else if (d.kind === 'removed') {
      removed.push(d.text);
    } else {
      added.push(d.text);
    }
  }
  flush();
  return out;
}

export function conflictHunks(server: string, mine: string): Hunk[] {
  return segments(server, mine).flatMap((s) => (s.kind === 'hunk' ? [s.hunk] : []));
}

/** Rebuild the document taking, for each hunk, the side the user picked (default: mine). */
export function mergeHunks(server: string, mine: string, picks: readonly Side[]): string {
  const lines: string[] = [];
  for (const s of segments(server, mine)) {
    if (s.kind === 'same') lines.push(s.line);
    else lines.push(...((picks[s.hunk.index] ?? 'mine') === 'mine' ? s.hunk.mine : s.hunk.server));
  }
  return lines.join('\n');
}
