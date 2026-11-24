import type { WorkProjectMembership } from '@qiu-creator/contracts';
import { describe, expect, it } from 'vitest';
import { byAgent, MembershipCache } from '../src/renderer/agent-assign.js';
import {
  addRuleValue,
  EMPTY_RULES,
  outcomeLabel,
  reasonsText,
  removeRuleValue,
  sameRules,
  scoreText,
} from '../src/renderer/project-rules-ui.js';

/** QC-091 on the QC-092 API: project rules and agent assignments, the pure parts. */

describe('rules', () => {
  it('adds values trimmed; tags lose their #, domains their scheme, path and www', () => {
    const a = addRuleValue(EMPTY_RULES, 'keywords', '  京都 ');
    expect(a !== null && 'rules' in a ? a.rules.keywords : null).toEqual(['京都']);
    const b = addRuleValue(EMPTY_RULES, 'tags', '#日本旅行');
    expect(b !== null && 'rules' in b ? b.rules.tags : null).toEqual(['日本旅行']);
    const c = addRuleValue(EMPTY_RULES, 'domains', 'https://www.Kyoto.travel/en/spots?x=1');
    expect(c !== null && 'rules' in c ? c.rules.domains : null).toEqual(['kyoto.travel']);
  });

  it('refuses a repeat or a bad domain, and ignores an empty value', () => {
    const rules = { ...EMPTY_RULES, keywords: ['京都'] };
    expect(addRuleValue(rules, 'keywords', '京都')).toEqual({ error: '已經有「京都」了' });
    expect(addRuleValue(rules, 'domains', 'not a domain')).toEqual({
      error: '網域要像 example.com',
    });
    expect(addRuleValue(rules, 'keywords', '   ')).toBeNull();
  });

  it('removes a value and compares rule sets', () => {
    const rules = { ...EMPTY_RULES, folders: ['/a', '/b'] };
    expect(removeRuleValue(rules, 'folders', '/a').folders).toEqual(['/b']);
    expect(sameRules(rules, { ...EMPTY_RULES, folders: ['/a', '/b'] })).toBe(true);
    expect(sameRules(rules, EMPTY_RULES)).toBe(false);
  });

  it('says why, strongest reason first, in the interface language', () => {
    expect(
      reasonsText([
        { kind: 'keyword_body', value: '京都', weight: 0.3 },
        { kind: 'tag', value: '京都', weight: 0.5 },
        { kind: 'keyword_title', value: '嵐山', weight: 0.6 },
      ]),
    ).toBe('標題出現「嵐山」；標籤 #京都；正文出現「京都」');
    expect(reasonsText([])).toBe('沒有符合的規則');
    expect(outcomeLabel('auto')).toBe('會自動歸入');
    expect(outcomeLabel('suggest')).toBe('只給建議');
    expect(scoreText(0.8)).toBe('0.80');
  });
});

describe('who put a work in a project', () => {
  const member = (kind: 'user' | 'agent' | 'rule'): WorkProjectMembership => ({
    project_id: 'p1',
    project_name: '京都旅行',
    added_by: {
      kind,
      token_id: null,
      token_name: null,
      score: null,
      reasons: [],
      at: '2026-11-24T00:00:00.000Z',
    },
  });

  it('marks agent and rule assignments, not the user’s own', () => {
    expect(byAgent(member('agent'))).toBe(true);
    expect(byAgent(member('rule'))).toBe(true);
    expect(byAgent(member('user'))).toBe(false);
  });

  it('reads each work once, a few at a time, and again after it changes', async () => {
    const asked: string[] = [];
    let open = 0;
    let most = 0;
    const cache = new MembershipCache(async (id) => {
      asked.push(id);
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 1));
      open--;
      return [member(id === 'w1' ? 'agent' : 'user')];
    }, 2);
    for (const id of ['w1', 'w2', 'w3', 'w1']) cache.want(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toEqual(['w1', 'w2', 'w3']);
    expect(most).toBe(2);
    expect(cache.get('w1')?.[0]?.added_by.kind).toBe('agent');
    cache.invalidate('w1');
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual(['w1', 'w2', 'w3', 'w1']);
    // After 保留 the answer is set directly, without asking again.
    cache.set('w2', [member('user')]);
    expect(cache.get('w2')?.[0]?.added_by.kind).toBe('user');
  });
});
