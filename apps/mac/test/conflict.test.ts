import { describe, expect, it } from 'vitest';
import { conflictHunks, mergeHunks } from '../src/renderer/conflict.js';

const server = '# 京都\n\n第一天 7 點出發。\n\n第二天去嵐山。\n\n第三天休息。\n';
const mine = '# 京都\n\n第一天 6:30 出發。\n\n第二天去嵐山。\n\n第三天去奈良。\n\n補充一段。\n';

describe('conflictHunks', () => {
  it('groups disagreeing lines into numbered hunks', () => {
    const hunks = conflictHunks(server, mine);
    expect(hunks.map((h) => [h.server, h.mine])).toEqual([
      [['第一天 7 點出發。'], ['第一天 6:30 出發。']],
      [['第三天休息。'], ['第三天去奈良。', '', '補充一段。']],
    ]);
    expect(hunks.map((h) => h.index)).toEqual([0, 1]);
  });

  it('returns no hunks for identical text', () => {
    expect(conflictHunks(server, server)).toEqual([]);
  });
});

describe('mergeHunks', () => {
  it('rebuilds mine or server exactly when every pick is the same side', () => {
    expect(mergeHunks(server, mine, ['mine', 'mine'])).toBe(mine);
    expect(mergeHunks(server, mine, ['server', 'server'])).toBe(server);
  });

  it('mixes sides per hunk', () => {
    expect(mergeHunks(server, mine, ['mine', 'server'])).toBe(
      '# 京都\n\n第一天 6:30 出發。\n\n第二天去嵐山。\n\n第三天休息。\n',
    );
  });

  it('handles pure insertions and deletions', () => {
    expect(mergeHunks('a\nb\n', 'a\nx\nb\n', ['server'])).toBe('a\nb\n');
    expect(mergeHunks('a\nb\nc\n', 'a\nc\n', ['server'])).toBe('a\nb\nc\n');
    expect(mergeHunks('a\nb\nc\n', 'a\nc\n', ['mine'])).toBe('a\nc\n');
  });
});
