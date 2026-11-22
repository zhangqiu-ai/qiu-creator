import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor';
import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownEditor, type MarkdownEditorHandle } from '../src/MarkdownEditor.js';
import { createEditorPlugins, TO_MARKDOWN_OPTIONS } from '../src/plugins.js';
import { protectRawSyntax, restoreRawSyntax } from '../src/raw.js';
import { mount } from './helpers.js';

/** One document per category the visual editor used to warn about (QC-072). */
const IMG = '<img height="351" width="351" src="assets/a.png" />';
const CASES: Record<string, { doc: string; raw: string[] }> = {
  'html block (img)': { doc: `# 標題\n\n${IMG}\n\n尾段。\n`, raw: [IMG] },
  'html block (div)': {
    doc: '前段。\n\n<div class="box">\n<b>粗</b>\n</div>\n\n尾段。\n',
    raw: ['<div class="box">\n<b>粗</b>\n</div>'],
  },
  'html comment': { doc: '前段。\n\n<!-- 備註 -->\n\n尾段。\n', raw: ['<!-- 備註 -->'] },
  'inline html': {
    doc: '段落裡有 <span style="color:red">HTML</span>，還有換行<br>與 <u>底線</u>。\n',
    raw: ['<span style="color:red">', '</span>', '<br>', '<u>', '</u>'],
  },
  footnote: { doc: '這裡有腳註[^1]。\n\n[^1]: 腳註內容。\n', raw: ['[^1]', '[^1]: 腳註內容。'] },
  'reference link': {
    doc: '[參照連結][ref] 與 ![圖][pic]\n\n[ref]: https://example.com\n[pic]: ./a.png "圖"\n',
    raw: ['[參照連結][ref]', '![圖][pic]', '[ref]: https://example.com', '[pic]: ./a.png "圖"'],
  },
  'table with escaped pipe': {
    doc: '| a | b |\n| - | - |\n| x \\| y | z |\n\n尾段。\n',
    raw: ['| a | b |\n| - | - |\n| x \\| y | z |'],
  },
  'table with line break': {
    doc: '| a | b |\n| - | - |\n| x<br>y | z |\n',
    raw: ['| a | b |\n| - | - |\n| x<br>y | z |'],
  },
  math: { doc: '前段。\n\n$$\na_b * c^2\n$$\n\n尾段。\n', raw: ['$$\na_b * c^2\n$$'] },
  directive: { doc: ':::note\n提示 _x_\n:::\n', raw: [':::note\n提示 _x_\n:::'] },
  'html in a list and a quote': {
    doc: '- 項目 <kbd>⌘</kbd>\n- <img src="a.png">\n\n> 引用 <br> 內\n',
    raw: ['<kbd>', '</kbd>', '<img src="a.png">', '<br>'],
  },
};

describe('raw syntax protection (QC-072)', () => {
  for (const [name, { doc, raw }] of Object.entries(CASES)) {
    it(`${name}: source → protected → source is byte-for-byte`, () => {
      const p = protectRawSyntax(doc);
      expect(p).not.toBeNull();
      if (p === null) return;
      for (const r of raw) expect(p.originals.join('\u0000')).toContain(r);
      for (const r of p.originals) expect(p.text).not.toContain(r);
      expect(restoreRawSyntax(p.text, p.originals)).toBe(doc.replace(/(?:)/, ''));
    });
  }

  it('refuses a document that already uses the placeholder tag', () => {
    expect(protectRawSyntax('<qc-raw n="0" />\n')).toBeNull();
  });
});

describe('visual editor keeps raw syntax through load, edit and save (QC-072)', () => {
  for (const [name, { doc, raw }] of Object.entries(CASES)) {
    it(`${name}: untouched`, async () => {
      const onChange = vi.fn();
      const ref = createRef<MarkdownEditorHandle>();
      const m = await mount(<MarkdownEditor ref={ref} markdown={doc} onChange={onChange} />);
      expect(ref.current?.getMode()).toBe('visual');
      expect(onChange).not.toHaveBeenCalled();
      expect(ref.current?.getMarkdown()).toBe(doc);
      m.unmount();
    });

    it(`${name}: still there, byte-for-byte, after an edit`, async () => {
      const p = protectRawSyntax(doc);
      if (p === null) throw new Error('not protected');
      const ref = createRef<MDXEditorMethods>();
      const errors: string[] = [];
      const m = await mount(
        <MDXEditor
          ref={ref}
          markdown={p.text}
          plugins={createEditorPlugins({ toolbar: false, rawOriginals: { current: p.originals } })}
          trim={false}
          toMarkdownOptions={TO_MARKDOWN_OPTIONS}
          onError={(e) => errors.push(e.error)}
        />,
      );
      await act(async () => {
        ref.current?.setMarkdown(`${p.text.trimEnd()}\n\n新增的一段。\n`);
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(errors).toEqual([]);
      const saved = restoreRawSyntax(ref.current?.getMarkdown() ?? '', p.originals);
      for (const r of raw) expect(saved).toContain(r);
      expect(saved).toContain('新增的一段。');
      m.unmount();
    });
  }

  it('shows an <img> as a picture, with its size', async () => {
    const m = await mount(
      <MarkdownEditor
        markdown={`${IMG}\n`}
        onChange={vi.fn()}
        resolveImage={(src) => Promise.resolve(`http://media.test/${src}`)}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const img = m.container.querySelector('.qc-raw img');
    expect(img?.getAttribute('src')).toBe('http://media.test/assets/a.png');
    expect(img?.getAttribute('width')).toBe('351');
    expect(img?.getAttribute('height')).toBe('351');
    m.unmount();
  });
});
