import type { ApiToken, ProposalDetail, ProposalHunk } from '@qiu-creator/contracts';
import { describe, expect, it } from 'vitest';
import {
  activityKind,
  activityText,
  mcpConfig,
  scopeSummary,
  sortTokens,
  tokenChangeText,
  toggleScope,
} from '../src/renderer/agents-settings.js';
import {
  acceptBlock,
  acceptInput,
  defaultPicks,
  hunkPlace,
  initials,
  lineRange,
  lineStats,
  ProposalCountsStore,
  revName,
} from '../src/renderer/proposals.js';

/** QC-091: Agent 提案 and 設定 › Agent 與 MCP, the pure parts. */

const hunk = (over: Partial<ProposalHunk> & { id: string }): ProposalHunk => ({
  base_start: 0,
  base_end: 1,
  removed: ['a'],
  added: ['b'],
  overlap: 'none',
  ...over,
});

const detail = (hunks: ProposalHunk[], status: ProposalDetail['status'] = 'pending') => ({
  status,
  hunks,
  current_revision: 'rev-now',
});

describe('accepting a proposal', () => {
  it('picks every change except the overlapping ones by default', () => {
    const d = detail([
      hunk({ id: 'h1' }),
      hunk({ id: 'h2', overlap: 'conflict' }),
      hunk({ id: 'h3' }),
    ]);
    expect([...defaultPicks(d)]).toEqual(['h1', 'h3']);
  });

  it('turns 採用 off with nothing picked, once decided, or with an overlapping change picked', () => {
    const d = detail([hunk({ id: 'h1' }), hunk({ id: 'h2', overlap: 'conflict' })]);
    expect(acceptBlock(d, new Set(['h1']))).toBeNull();
    expect(acceptBlock(d, new Set())).toBe('none');
    expect(acceptBlock(d, new Set(['h1', 'h2']))).toBe('conflict');
    expect(acceptBlock(detail(d.hunks, 'discarded'), new Set(['h1']))).toBe('decided');
  });

  it('sends hunk_ids only for a partial choice, on the revision the user sees', () => {
    const d = detail([hunk({ id: 'h1' }), hunk({ id: 'h2' }), hunk({ id: 'h3' })]);
    expect(acceptInput(d, new Set(['h1', 'h2', 'h3']))).toEqual({ base_revision: 'rev-now' });
    expect(acceptInput(d, new Set(['h3', 'h1']))).toEqual({
      base_revision: 'rev-now',
      hunk_ids: ['h1', 'h3'],
    });
  });

  it('counts lines added and removed', () => {
    expect(
      lineStats([
        hunk({ id: 'h1', removed: ['x'], added: ['y', 'z'] }),
        hunk({ id: 'h2', removed: [], added: ['w'] }),
      ]),
    ).toEqual({ added: 3, removed: 1 });
  });
});

describe('where a change sits in the text', () => {
  const base = '# T\n\n第一段。\n\n第二段。\n';

  it('maps base lines to character offsets', () => {
    expect(lineRange(base, 2, 3)).toEqual({ start: 5, end: 9 });
    expect(base.slice(5, 9)).toBe('第一段。');
  });

  it('finds the replaced lines by line while the work is at the base, by text after it moved', () => {
    const h = { base_start: 4, base_end: 5, removed: ['第二段。'] };
    expect(hunkPlace(base, base, h)).toEqual({ start: 11, end: 15 });
    const moved = '# T\n\n前言。\n\n第一段。\n\n第二段。\n';
    const at = hunkPlace(moved, base, h);
    expect(at === null ? '' : moved.slice(at.start, at.end)).toBe('第二段。');
  });

  it('anchors an insertion on the line before it; gives up when the text is gone or repeated', () => {
    const insert = { base_start: 3, base_end: 3, removed: [] };
    const at = hunkPlace(base, base, insert);
    expect(at === null ? '' : base.slice(at.start, at.end)).toBe('第一段。');
    expect(
      hunkPlace('全部改掉了', base, { base_start: 4, base_end: 5, removed: ['第二段。'] }),
    ).toBeNull();
    expect(
      hunkPlace('第二段。\n第二段。', base, { base_start: 4, base_end: 5, removed: ['第二段。'] }),
    ).toBeNull();
  });
});

describe('names and counts', () => {
  it('names revisions r1, r2 … and avatars by initials', () => {
    expect(revName(new Map([['abc', 12]]), 'abc')).toBe('r12');
    expect(revName(new Map(), 'abcdef0123')).toBe('abcdef01');
    expect(initials('Claude Code')).toBe('CC');
    expect(initials('codex')).toBe('CO');
    expect(initials('Obsidian 同步')).toBe('OB');
    expect(initials('小助手')).toBe('小');
  });

  it('keeps only the newest counts when answers arrive out of order', async () => {
    const replies: ((v: { pending: number; by_work: Record<string, number> }) => void)[] = [];
    const store = new ProposalCountsStore(
      () =>
        new Promise((resolve) => {
          replies.push(resolve);
        }),
    );
    const first = store.refresh();
    const second = store.refresh();
    replies[1]?.({ pending: 2, by_work: { w: 2 } });
    replies[0]?.({ pending: 9, by_work: {} });
    await Promise.all([first, second]);
    expect(store.getSnapshot()).toEqual({ pending: 2, byWork: { w: 2 } });
  });
});

describe('agent tokens', () => {
  const token = (over: Partial<ApiToken> & { id: string }): ApiToken => ({
    name: over.id,
    prefix: 'chk_',
    scopes: ['read'],
    created_at: '2026-11-24T00:00:00.000Z',
    last_used_at: null,
    revoked_at: null,
    ...over,
  });

  it('lists active tokens newest first, then revoked ones', () => {
    const sorted = sortTokens([
      token({ id: 'old', created_at: '2026-11-01T00:00:00.000Z' }),
      token({
        id: 'gone',
        revoked_at: '2026-11-20T00:00:00.000Z',
        created_at: '2026-11-23T00:00:00.000Z',
      }),
      token({ id: 'new', created_at: '2026-11-22T00:00:00.000Z' }),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['new', 'old', 'gone']);
  });

  it('summarises scopes in a fixed order and never toggles the last one off', () => {
    expect(scopeSummary(['propose', 'read'])).toBe('讀取・提案修改正文');
    expect(toggleScope(['read'], 'propose')).toEqual(['read', 'propose']);
    expect(toggleScope(['propose', 'read'], 'read')).toEqual(['propose']);
    expect(toggleScope(['read'], 'read')).toBeNull();
  });

  it('copies an MCP config with the secret, or a placeholder when it is not known', () => {
    const withSecret = JSON.parse(mcpConfig('chk_secret')) as {
      mcpServers: { creatorhub: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(withSecret.mcpServers.creatorhub.args.at(-1)).toBe('mcp');
    expect(withSecret.mcpServers.creatorhub.env['CREATORHUB_TOKEN']).toBe('chk_secret');
    expect(mcpConfig(null)).toContain('"CREATORHUB_TOKEN": "貼上權杖"');
  });

  it('reads activity entries in words', () => {
    const a = {
      kind: 'request' as const,
      method: 'POST',
      route: '/api/v1/works/:id/proposals',
      result: 'ok' as const,
      reason: null,
      code: null,
    };
    expect(activityKind(a, false)).toBe('propose');
    expect(activityText(a, 'propose', '京都').line).toBe('提案修改「京都」');
    const edit = { ...a, method: 'PATCH', route: '/api/v1/works/:id' };
    expect(activityKind(edit, true)).toBe('direct');
    expect(activityKind(edit, false)).toBe('edit');
    const refused = {
      ...edit,
      result: 'rejected' as const,
      code: 'direct_edit_not_allowed',
      reason: '不能直接修改正文',
    };
    expect(activityText(refused, 'edit', null)).toEqual({
      line: '修改「（已不在範圍內的作品）」',
      detail: '被拒絕：不能直接修改正文',
    });
    expect(
      activityKind({ kind: 'token_updated', method: 'PATCH', route: '/api/v1/tokens/:id' }, false),
    ).toBe('token');
    expect(activityKind({ ...a, method: 'POST', route: '/api/v1/works' }, false)).toBe('create');
  });

  it('says what the owner changed on a token in words', () => {
    expect(
      tokenChangeText(
        'scopes: read,import → read,import,propose; allow_direct_body_edit: false → true; project_ids: all → p1',
        (id) => (id === 'p1' ? '京都旅行' : id),
      ),
    ).toBe(
      '可以做什麼：讀取・匯入 → 讀取・匯入・提案修改正文；允許直接修改正文：關 → 開；可以動哪些項目：所有作品 → 京都旅行',
    );
    expect(tokenChangeText('something else', (id) => id)).toBe('something else');
  });
});
