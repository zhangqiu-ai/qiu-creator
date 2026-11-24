import { describe, expect, it } from 'vitest';
import {
  applyHunks,
  conflictRegions,
  HunkConflictError,
  overlappingHunks,
  proposalHunks,
  rangesOverlap,
} from '../src/index.js';

const BASE = ['# 標題', '', '第一段。', '', '第二段。', '', '第三段。'].join('\n');

describe('proposalHunks', () => {
  it('splits a proposal into ordered hunks with stable ids', () => {
    const proposed = BASE.replace('第一段。', '第一段改。').replace(
      '第三段。',
      '第三段改。\n\n新增段。',
    );
    const hunks = proposalHunks(BASE, proposed);
    expect(hunks).toEqual([
      { id: 'h1', base_start: 2, base_end: 3, removed: ['第一段。'], added: ['第一段改。'] },
      {
        id: 'h2',
        base_start: 6,
        base_end: 7,
        removed: ['第三段。'],
        added: ['第三段改。', '', '新增段。'],
      },
    ]);
    expect(proposalHunks(BASE, BASE)).toEqual([]);
  });

  it('records insertions and deletions', () => {
    const inserted = proposalHunks('a\nb', 'a\nx\nb');
    expect(inserted).toEqual([{ id: 'h1', base_start: 1, base_end: 1, removed: [], added: ['x'] }]);
    const deleted = proposalHunks('a\nb\nc', 'a\nc');
    expect(deleted).toEqual([{ id: 'h1', base_start: 1, base_end: 2, removed: ['b'], added: [] }]);
  });
});

describe('rangesOverlap', () => {
  it('collides on shared lines and on insertion points at an edge', () => {
    expect(rangesOverlap({ start: 1, end: 3 }, { start: 2, end: 4 })).toBe(true);
    expect(rangesOverlap({ start: 1, end: 3 }, { start: 3, end: 5 })).toBe(false);
    expect(rangesOverlap({ start: 3, end: 3 }, { start: 1, end: 3 })).toBe(true);
    expect(rangesOverlap({ start: 4, end: 4 }, { start: 1, end: 3 })).toBe(false);
  });
});

describe('applyHunks', () => {
  const proposed = BASE.replace('第一段。', '第一段改。').replace('第三段。', '第三段改。');

  it('applies to the base itself', () => {
    expect(applyHunks(BASE, BASE, proposalHunks(BASE, proposed))).toBe(proposed);
  });

  it('applies chosen hunks only', () => {
    const [h1] = proposalHunks(BASE, proposed);
    expect(applyHunks(BASE, BASE, h1 === undefined ? [] : [h1])).toBe(
      BASE.replace('第一段。', '第一段改。'),
    );
  });

  it('rebases onto later edits elsewhere (stale but clean)', () => {
    const current = `前言。\n\n${BASE.replace('第二段。', '第二段（使用者改）。')}`;
    const hunks = proposalHunks(BASE, proposed);
    expect(overlappingHunks(BASE, current, hunks).size).toBe(0);
    expect(applyHunks(BASE, current, hunks)).toBe(
      `前言。\n\n${proposed.replace('第二段。', '第二段（使用者改）。')}`,
    );
  });

  it('refuses hunks that overlap later edits and gives three-way regions', () => {
    const current = BASE.replace('第一段。', '第一段（使用者改）。');
    const hunks = proposalHunks(BASE, proposed);
    expect([...overlappingHunks(BASE, current, hunks)]).toEqual(['h1']);
    expect(() => applyHunks(BASE, current, hunks)).toThrow(HunkConflictError);
    // The other hunk still applies on its own.
    expect(
      applyHunks(
        BASE,
        current,
        hunks.filter((h) => h.id === 'h2'),
      ),
    ).toBe(current.replace('第三段。', '第三段改。'));
    expect(conflictRegions(BASE, current, proposed, hunks)).toEqual([
      {
        hunk_ids: ['h1'],
        base_start: 2,
        base_end: 3,
        base: '第一段。',
        mine: '第一段（使用者改）。',
        theirs: '第一段改。',
      },
    ]);
  });

  it('treats an insertion right where the user edited as a conflict', () => {
    const base = 'a\nb\nc';
    const hunks = proposalHunks(base, 'a\nb\nX\nc');
    expect([...overlappingHunks(base, 'a\nB\nc', hunks)]).toEqual(['h1']);
    expect([...overlappingHunks(base, 'A\nb\nc', hunks)]).toEqual([]);
    expect(applyHunks(base, 'A\nb\nc', hunks)).toBe('A\nb\nX\nc');
  });
});
