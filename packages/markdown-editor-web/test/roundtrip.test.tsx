import { describe, expect, it } from 'vitest';
import { markdownStructure } from '../src/lossy.js';
import { visualRoundTrip } from './helpers.js';

import { fixture } from './fixture.js';

/**
 * Markdown read -> edit -> write -> read again through the real visual editor.
 * "Main structure" = the mdast tree (headings, lists, tables, code, links,
 * images, text) without positions and tight/loose list spacing.
 */
describe('visual editor Markdown round trip', () => {
  for (const name of ['structure.md', 'long-chinese.md']) {
    it(`keeps the structure of ${name} through load, edit, save and reload`, async () => {
      const original = fixture(name);

      // read -> write without edits
      const exported = await visualRoundTrip(original);
      expect(markdownStructure(exported)).toEqual(markdownStructure(original));

      // edit -> write
      const appended = '新增的一段：編輯後寫回。';
      const edited = await visualRoundTrip(exported, (e) => {
        e.setMarkdown(`${exported.trimEnd()}\n\n${appended}\n`);
      });
      expect(edited).toContain(appended);
      expect(markdownStructure(edited)).toEqual(
        markdownStructure(`${original.trimEnd()}\n\n${appended}\n`),
      );

      // read again: stable, nothing else drifts
      const reloaded = await visualRoundTrip(edited);
      expect(reloaded).toBe(edited);
    }, 30_000);
  }

  it('keeps each structural element of the fixture', async () => {
    const out = await visualRoundTrip(fixture('structure.md'));
    expect(out).toContain('# 旅行筆記：京都三日');
    expect(out).toMatch(/\|\s*地點\s*\|\s*時間\s*\|\s*花費\s*\|/);
    expect(out).toMatch(/:-+:/); // center alignment
    expect(out).toMatch(/-+:\s*\|/); // right alignment
    expect(out).toContain('```ts');
    expect(out).toContain('return `你好，${name}`;');
    expect(out).toContain('[京都觀光](https://example.com/kyoto "京都觀光網站")');
    expect(out).toContain('![鴨川夕陽](https://example.com/images/kamo.jpg)');
    expect(out).toContain('![相對路徑圖片](./assets/temple.png)');
    expect(out).toContain('`npm run dev`');
  });
});

describe('serialisation style', () => {
  it('keeps "-" bullets and thematic breaks', async () => {
    const out = await visualRoundTrip('- 一\n- 二\n\n---\n\n段落\n');
    expect(out.trimEnd()).toBe('- 一\n- 二\n\n---\n\n段落');
  });
});

describe('table serialisation', () => {
  it('does not pad columns, so header and data rows keep their text', async () => {
    const table = '| 地點 | 時間 |\n| --- | :-: |\n| 伏見稻荷 | 08:00 |\n';
    const out = await visualRoundTrip(table);
    // Only the delimiter row is normalised (`---` -> `-`); alignment is kept.
    expect(out.trimEnd()).toBe('| 地點 | 時間 |\n| - | :-: |\n| 伏見稻荷 | 08:00 |');
    expect(await visualRoundTrip(out)).toBe(out);
  });
});
