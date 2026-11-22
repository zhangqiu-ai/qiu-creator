import type { Prompt } from '@qiu-creator/contracts';
import { describe, expect, it } from 'vitest';
import {
  afterRemoval,
  changeCount,
  customIds,
  draftChanged,
  draftOf,
  dropCustom,
  emptyDraft,
  exportFileName,
  firstSelection,
  groupNames,
  groupPrompts,
  insertVariable,
  isVariable,
  matchesPrompt,
  modelFromKey,
  modelKey,
  moveCustom,
  parseImport,
  previewLine,
  sameDraft,
  savable,
  splitVariables,
  VARIABLE_CHIPS,
} from '../src/renderer/prompts-page.js';

/** QC-075: the Prompt 庫 page's pure pieces (PT-20261122-003). */

function prompt(over: Partial<Prompt> & { id: string }): Prompt {
  return {
    builtin: false,
    name: over.id,
    group: null,
    scene: 'selection',
    content: '',
    model: null,
    language: null,
    revision: 1,
    use_count: 0,
    last_used_at: null,
    created_at: null,
    updated_at: null,
    ...over,
  };
}

const LABELS = { builtin: '內建', ungrouped: '未分組' };

describe('variables', () => {
  it('offers the five chips in the prototype order', () => {
    expect(VARIABLE_CHIPS.map((c) => c.token)).toEqual([
      '{選取}',
      '{標題}',
      '{全文}',
      '{平台}',
      '{語言}',
    ]);
  });

  it('marks both the Traditional and the Simplified spelling', () => {
    expect(splitVariables('把 {選取} 改成 {语言}。')).toEqual([
      { text: '把 ', variable: false },
      { text: '{選取}', variable: true },
      { text: ' 改成 ', variable: false },
      { text: '{语言}', variable: true },
      { text: '。', variable: false },
    ]);
  });

  it('leaves unknown braces alone, as the server does', () => {
    expect(splitVariables('{標籤} 不是變數')).toEqual([
      { text: '{標籤} 不是變數', variable: false },
    ]);
    expect(isVariable('{標題}')).toBe(true);
    expect(isVariable('{標籤}')).toBe(false);
  });

  it('inserts a chip at the cursor and replaces a selection', () => {
    expect(insertVariable('把  改口語', 2, 2, '{選取}')).toEqual({
      content: '把 {選取} 改口語',
      caret: 6,
    });
    expect(insertVariable('把全文改口語', 1, 3, '{選取}')).toEqual({
      content: '把{選取}改口語',
      caret: 5,
    });
    // Out-of-range offsets land at the end rather than throwing.
    expect(insertVariable('abc', 99, 99, '{全文}').content).toBe('abc{全文}');
  });
});

describe('the grouped list', () => {
  const list: Prompt[] = [
    prompt({ id: 'builtin-polish', builtin: true, name: '潤色', content: '修順 {選取}。' }),
    prompt({
      id: 'c1',
      name: '小紅書口吻',
      group: '小紅書',
      content: '把 {選取} 改寫成小紅書口吻。',
    }),
    prompt({ id: 'c2', name: '加 emoji', group: '小紅書', content: '加入 emoji。' }),
    prompt({ id: 'c3', name: '開頭鉤子', group: '公眾號', content: '依 {全文} 寫開頭。' }),
    prompt({ id: 'c4', name: '隨手記', group: null, content: '隨便寫。' }),
  ];

  it('puts 內建 first, then the groups in order, with the ungrouped last', () => {
    const groups = groupPrompts(list, '', LABELS);
    expect(groups.map((g) => [g.name, g.items.map((p) => p.id)])).toEqual([
      ['內建', ['builtin-polish']],
      ['小紅書', ['c1', 'c2']],
      ['公眾號', ['c3']],
      ['未分組', ['c4']],
    ]);
  });

  it('keeps only the groups that have a hit while searching', () => {
    const groups = groupPrompts(list, '開頭', LABELS);
    expect(groups.map((g) => g.name)).toEqual(['公眾號']);
  });

  it('matches a prompt by name, content or group', () => {
    const c1 = list[1] as Prompt;
    expect(matchesPrompt(c1, '小紅書')).toBe(true);
    expect(matchesPrompt(c1, '改寫')).toBe(true);
    expect(matchesPrompt(c1, '公眾號')).toBe(false);
    // Traditional and Simplified match each other (QC-068 的 domain/search).
    expect(matchesPrompt(c1, '小红书')).toBe(true);
    expect(matchesPrompt(c1, '')).toBe(true);
  });

  it('lists the custom ids, the groups in use and the first selection', () => {
    expect(customIds(list)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(groupNames(list)).toEqual(['小紅書', '公眾號']);
    expect(firstSelection(list)).toBe('c1');
    expect(firstSelection(list.filter((p) => p.builtin))).toBeNull();
  });

  it('reorders only the custom prompts', () => {
    expect(moveCustom(list, 'c3', -1)).toEqual(['c1', 'c3', 'c2', 'c4']);
    expect(moveCustom(list, 'c1', -1)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(moveCustom(list, 'c4', 1)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(dropCustom(list, 'c1', 'c4')).toEqual(['c2', 'c3', 'c4', 'c1']);
    expect(dropCustom(list, 'c4', 'c1')).toEqual(['c4', 'c1', 'c2', 'c3']);
    expect(dropCustom(list, 'c1', 'c1')).toBeNull();
    expect(dropCustom(list, 'c1', 'builtin-polish')).toBeNull();
  });

  it('selects the next prompt after a deletion, else the one before', () => {
    expect(afterRemoval(list, 'c2')).toBe('c3');
    expect(afterRemoval(list, 'c4')).toBe('c3');
    expect(afterRemoval([prompt({ id: 'only' })], 'only')).toBeNull();
    expect(afterRemoval(list, 'nope')).toBeNull();
  });

  it('shows one line of the content in a row', () => {
    expect(previewLine('第一行\n第二行')).toBe('第一行 第二行');
    expect(previewLine('一二三四五', 3)).toBe('一二三…');
  });
});

describe('the editor draft', () => {
  const saved = prompt({
    id: 'c1',
    name: '口語',
    group: '小紅書',
    content: '把 {選取} 改口語。',
    scene: 'full',
    language: 'zh-Hant',
    model: { provider: 'anthropic', model: 'claude-opus-5-5' },
  });

  it('starts from the saved prompt and notices every change', () => {
    const draft = draftOf(saved);
    expect(draft).toEqual({
      name: '口語',
      content: '把 {選取} 改口語。',
      scene: 'full',
      group: '小紅書',
      model: { provider: 'anthropic', model: 'claude-opus-5-5' },
      language: 'zh-Hant',
    });
    expect(draftChanged(draft, saved)).toBe(false);
    expect(draftChanged({ ...draft, name: '更口語' }, saved)).toBe(true);
    expect(draftChanged({ ...draft, scene: 'title' }, saved)).toBe(true);
    expect(draftChanged({ ...draft, language: null }, saved)).toBe(true);
    expect(draftChanged({ ...draft, model: null }, saved)).toBe(true);
    // The service trims, so trailing spaces in 分組 are not a change.
    expect(draftChanged({ ...draft, group: '小紅書 ' }, saved)).toBe(false);
    // Two drafts: what a save compares to decide whether anything was typed meanwhile.
    expect(sameDraft(draft, draftOf(saved))).toBe(true);
    expect(sameDraft(draft, { ...draft, content: `${draft.content}。` })).toBe(false);
  });

  it('is saved only once it has a name and content', () => {
    expect(savable(emptyDraft())).toBe(false);
    expect(savable({ ...emptyDraft(), name: '口語' })).toBe(false);
    expect(savable({ ...emptyDraft(), name: ' ', content: '把 {選取} 改口語。' })).toBe(false);
    expect(savable({ ...emptyDraft(), name: '口語', content: '把 {選取} 改口語。' })).toBe(true);
  });

  it('keeps 預設模型 as one value in the list', () => {
    expect(modelKey(null)).toBe('');
    expect(modelKey({ provider: 'new-api', model: 'gpt-5.5' })).toBe('new-api:gpt-5.5');
    expect(modelFromKey('new-api:gpt-5.5')).toEqual({ provider: 'new-api', model: 'gpt-5.5' });
    // 沿用工具列, and anything that is not a known provider.
    expect(modelFromKey('')).toBeNull();
    expect(modelFromKey('nope:x')).toBeNull();
    expect(modelFromKey('anthropic:')).toBeNull();
  });

  it('says how much longer or shorter a candidate is', () => {
    expect(changeCount('一二三', '一二三四五')).toBe('+2');
    expect(changeCount('一二三', '一')).toBe('-2');
    expect(changeCount('一二三', '一二三')).toBe('+0');
  });
});

describe('export and import', () => {
  it('names the exported file after the day', () => {
    expect(exportFileName(new Date(2026, 10, 2))).toBe('prompts-2026-11-02.json');
  });

  it('takes a prompt export and refuses anything else', () => {
    const file = {
      version: 1,
      prompts: [{ name: '口語', content: '把 {選取} 改口語。', scene: 'selection' }],
    };
    expect(parseImport(JSON.stringify(file))?.prompts).toHaveLength(1);
    expect(parseImport('not json')).toBeNull();
    expect(parseImport('{"version":2,"prompts":[]}')).toBeNull();
    expect(parseImport('{"prompts":[{"name":"x"}]}')).toBeNull();
  });
});
