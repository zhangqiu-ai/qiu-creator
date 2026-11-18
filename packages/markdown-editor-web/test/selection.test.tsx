import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownEditor, type MarkdownEditorHandle } from '../src/MarkdownEditor.js';
import {
  blockNumbers,
  expandToBlocks,
  markdownBlocks,
  rangeForBlockTexts,
} from '../src/selection.js';
import { mount } from './helpers.js';

const MD =
  '# 標題\n\n第一段，**粗體**和[連結](https://example.com)。\n\n第二段。\n\n- 清單一\n- 清單二\n';

describe('Markdown blocks (QC-024 selection)', () => {
  it('lists top-level blocks with offsets and visible text', () => {
    const blocks = markdownBlocks(MD);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph', 'list']);
    expect(blocks.map((b) => MD.slice(b.start, b.end))).toEqual([
      '# 標題',
      '第一段，**粗體**和[連結](https://example.com)。',
      '第二段。',
      '- 清單一\n- 清單二',
    ]);
    expect(blocks[1]?.text).toBe('第一段，粗體和連結。');
  });

  it('widens a range to whole blocks and a caret to its block', () => {
    const second = MD.indexOf('第二段');
    expect(expandToBlocks(MD, { start: second + 1, end: second + 2 })).toEqual({
      start: second,
      end: second + '第二段。'.length,
    });
    const first = MD.indexOf('第一段');
    const r = expandToBlocks(MD, { start: first + 2, end: second + 1 });
    expect(r && MD.slice(r.start, r.end)).toBe(MD.slice(first, second + '第二段。'.length));
    // A caret on the blank line between blocks picks the next block.
    expect(expandToBlocks(MD, { start: second - 1, end: second - 1 })?.start).toBe(second);
    expect(expandToBlocks('', { start: 0, end: 0 })).toBeNull();
  });

  it('matches rendered blocks by text and prefers the hinted duplicate', () => {
    const md = '同一句。\n\n中間。\n\n同一句。\n';
    const second = md.lastIndexOf('同一句');
    expect(rangeForBlockTexts(md, '同一句。', '同一句。', { start: 2, end: 2 })).toEqual({
      start: second,
      end: second + '同一句。'.length,
    });
    expect(rangeForBlockTexts(md, '同一句。', '中間。')).toEqual({
      start: 0,
      end: md.indexOf('中間。') + 3,
    });
    expect(rangeForBlockTexts(md, '不存在', '不存在')).toBeNull();
  });

  it('numbers the blocks a range covers', () => {
    const first = MD.indexOf('第一段');
    const second = MD.indexOf('第二段');
    expect(blockNumbers(MD, { start: first, end: second + 2 })).toEqual({ first: 2, last: 3 });
  });
});

describe('MarkdownEditor selection range', () => {
  it('reports source-mode selections and widens a caret to its block', async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onSelectionChange = vi.fn();
    const m = await mount(
      <MarkdownEditor
        ref={ref}
        markdown={MD}
        initialMode="source"
        onChange={() => undefined}
        onSelectionChange={onSelectionChange}
      />,
    );
    const ta = m.container.querySelector('textarea') as HTMLTextAreaElement;
    const second = MD.indexOf('第二段');
    act(() => {
      ta.setSelectionRange(second, second + 2);
      ta.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(ref.current?.getSelectionRange()).toEqual({ start: second, end: second + 2 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: second, end: second + 2 });
    ta.setSelectionRange(second + 1, second + 1);
    expect(ref.current?.getSelectionRange()).toEqual({ start: second, end: second + 4 });
    m.unmount();
  });

  it('maps a visual-mode selection to whole source blocks', async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const m = await mount(<MarkdownEditor ref={ref} markdown={MD} onChange={() => undefined} />);
    const content = m.container.querySelector('.qc-md-editor__content');
    const paragraphs = content?.querySelectorAll(':scope > p') ?? [];
    const p2 = paragraphs[1];
    const target = p2 ? document.createTreeWalker(p2, NodeFilter.SHOW_TEXT).nextNode() : null;
    expect(target).toBeTruthy();
    const range = document.createRange();
    range.setStart(target as Node, 1);
    range.setEnd(target as Node, 2);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const second = MD.indexOf('第二段');
    expect(ref.current?.getSelectionRange()).toEqual({ start: second, end: second + 4 });
    // A selection outside the editor is not the editor's.
    const outside = document.createElement('p');
    outside.textContent = '外面';
    document.body.appendChild(outside);
    const r2 = document.createRange();
    r2.selectNodeContents(outside);
    sel?.removeAllRanges();
    sel?.addRange(r2);
    expect(ref.current?.getSelectionRange()).toBeNull();
    outside.remove();
    m.unmount();
  });
});
