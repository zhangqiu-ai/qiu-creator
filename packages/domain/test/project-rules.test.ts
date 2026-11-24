import { describe, expect, it } from 'vitest';
import { matchRules, outcomeOf } from '../src/project-rules.js';

const empty = { keywords: [], tags: [], folders: [], domains: [] };

describe('matchRules', () => {
  it('never matches empty rules', () => {
    expect(matchRules({ title: '京都', markdown: '京都', tags: [] }, empty)).toEqual({
      score: 0,
      outcome: 'none',
      reasons: [],
    });
  });

  it('combines evidence: title keyword plus tag is auto, either alone suggests', () => {
    const rules = { ...empty, keywords: ['京都'], tags: ['旅行'] };
    const both = matchRules({ title: '京都秋天', markdown: '', tags: ['旅行'] }, rules);
    expect(both.score).toBe(0.84);
    expect(both.outcome).toBe('auto');
    expect(both.reasons.map((r) => r.text)).toEqual(['標題出現「京都」', '有標籤「旅行」']);
    expect(matchRules({ title: '京都秋天', markdown: '', tags: [] }, rules)).toMatchObject({
      score: 0.6,
      outcome: 'suggest',
    });
    expect(matchRules({ title: 'x', markdown: '', tags: ['旅行'] }, rules).outcome).toBe('suggest');
  });

  it('counts body keywords once each, folded for case and Traditional/Simplified', () => {
    const rules = { ...empty, keywords: ['紅葉', 'Arashiyama', '红叶'] };
    const m = matchRules(
      { title: 'x', markdown: '今年红叶很早。ARASHIYAMA 人很多。紅葉！', tags: [] },
      rules,
    );
    expect(m.reasons.map((r) => [r.kind, r.value])).toEqual([
      ['keyword_body', '紅葉'],
      ['keyword_body', 'Arashiyama'],
    ]);
    expect(m.score).toBe(0.58);
    expect(m.outcome).toBe('suggest');
    expect(matchRules({ title: 'x', markdown: '紅葉', tags: [] }, rules).outcome).toBe('none');
  });

  it('matches folders by mount id or path prefix, and domains with subdomains', () => {
    const rules = {
      ...empty,
      folders: ['/Users/me/Notes/Kyoto', 'mount-1'],
      domains: ['example.com'],
    };
    expect(
      matchRules(
        { title: 'x', markdown: '', tags: [], filePath: '/Users/me/Notes/Kyoto/a.md' },
        rules,
      ),
    ).toMatchObject({ score: 0.9, outcome: 'auto' });
    expect(
      matchRules(
        { title: 'x', markdown: '', tags: [], filePath: '/Users/me/Notes/Kyoto2/a.md' },
        rules,
      ).score,
    ).toBe(0);
    expect(
      matchRules({ title: 'x', markdown: '', tags: [], mountId: 'mount-1' }, rules).score,
    ).toBe(0.9);
    expect(
      matchRules(
        { title: 'x', markdown: '看 [這裡](https://blog.example.com/p)', tags: [] },
        rules,
      ).reasons.map((r) => r.text),
    ).toEqual(['來源或連結在「example.com」']);
    expect(
      matchRules({ title: 'x', markdown: '', tags: [], source: 'https://notexample.com/' }, rules)
        .score,
    ).toBe(0);
  });

  it('maps scores to outcomes at 0.8 and 0.5', () => {
    expect([outcomeOf(0.8), outcomeOf(0.79), outcomeOf(0.5), outcomeOf(0.49)]).toEqual([
      'auto',
      'suggest',
      'suggest',
      'none',
    ]);
  });
});
