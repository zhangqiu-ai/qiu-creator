import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownEditor, type MarkdownEditorHandle } from '../src/MarkdownEditor.js';
import { mount } from './helpers.js';

import { fixture } from './fixture.js';

function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('MarkdownEditor', () => {
  it('does not report a change just for opening a document', async () => {
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorHandle>();
    const original = fixture('structure.md');
    const m = await mount(<MarkdownEditor ref={ref} markdown={original} onChange={onChange} />);
    expect(ref.current?.getMode()).toBe('visual');
    expect(onChange).not.toHaveBeenCalled();
    expect(ref.current?.getMarkdown()).toBe(original);
    m.unmount();
  });

  it('relabels its toolbar when the language changes, without reloading the document (QC-047)', async () => {
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorHandle>();
    const original = fixture('structure.md');
    const m = await mount(
      <MarkdownEditor ref={ref} markdown={original} onChange={onChange} locale="zh-Hant" />,
    );
    const content = m.container.querySelector('.qc-md-editor__content');
    expect(m.container.textContent).toContain('段落樣式');
    await act(async () => {
      m.root.render(
        <MarkdownEditor ref={ref} markdown={original} onChange={onChange} locale="en" />,
      );
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(m.container.textContent).toContain('Block style');
    expect(m.container.textContent).not.toContain('段落樣式');
    // The same editing surface: not rebuilt, nothing reported as changed.
    expect(m.container.querySelector('.qc-md-editor__content')).toBe(content);
    expect(onChange).not.toHaveBeenCalled();
    expect(ref.current?.getMarkdown()).toBe(original);
    m.unmount();
  });

  it('opens a document with raw syntax in visual mode, unchanged (QC-072)', async () => {
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorHandle>();
    const original = fixture('lossy.md');
    const m = await mount(<MarkdownEditor ref={ref} markdown={original} onChange={onChange} />);
    expect(ref.current?.getMode()).toBe('visual');
    expect(onChange).not.toHaveBeenCalled();
    expect(ref.current?.getMarkdown()).toBe(original);
    m.unmount();
  });

  it('switches to visual and back at once, with no confirmation and no change (QC-072)', async () => {
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorHandle>();
    const original = fixture('lossy.md');
    const m = await mount(
      <MarkdownEditor ref={ref} markdown={original} initialMode="source" onChange={onChange} />,
    );
    expect(ref.current?.getMode()).toBe('source');
    const visualButton = [...m.container.querySelectorAll('button')].find(
      (b) => b.textContent === '視覺',
    );
    act(() => {
      visualButton?.click();
    });
    expect(m.container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(ref.current?.getMode()).toBe('visual');
    act(() => {
      ref.current?.requestMode('source');
    });
    expect(m.container.querySelector('textarea')?.value).toBe(original);
    expect(onChange).not.toHaveBeenCalled();
    m.unmount();
  });

  it('keeps editing in source mode byte-for-byte', async () => {
    const onChange = vi.fn();
    const original = fixture('lossy.md');
    const m = await mount(
      <MarkdownEditor markdown={original} initialMode="source" onChange={onChange} />,
    );
    const ta = m.container.querySelector('textarea');
    const edited = `${original}\n補一句。\n`;
    act(() => {
      if (ta) setTextareaValue(ta, edited);
    });
    expect(onChange).toHaveBeenLastCalledWith(edited);
    m.unmount();
  });

  it('holds changes during IME composition and reports them when it ends', async () => {
    const onChange = vi.fn();
    const onComposition = vi.fn();
    const m = await mount(
      <MarkdownEditor
        markdown=""
        initialMode="source"
        onChange={onChange}
        onCompositionChange={onComposition}
      />,
    );
    const ta = m.container.querySelector('textarea');
    if (!ta) throw new Error('no textarea');

    act(() => {
      ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      setTextareaValue(ta, 'zhong');
      setTextareaValue(ta, '中');
    });
    expect(onComposition).toHaveBeenLastCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(ta.value).toBe('中');

    await act(async () => {
      ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
      await Promise.resolve();
    });
    expect(onComposition).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('中');
    m.unmount();
  });
});

describe('MarkdownEditor without its own mode switch', () => {
  it('hides the switch and still changes mode through the handle', async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onModeChange = vi.fn();
    const m = await mount(
      <MarkdownEditor
        ref={ref}
        markdown={'# 標題\n'}
        onChange={vi.fn()}
        onModeChange={onModeChange}
        showModeSwitch={false}
      />,
    );
    expect(m.container.querySelector('.qc-md-editor__modes')).toBeNull();
    act(() => {
      ref.current?.requestMode('source');
    });
    expect(ref.current?.getMode()).toBe('source');
    expect(onModeChange).toHaveBeenLastCalledWith('source');
    expect(m.container.querySelector('textarea')?.value).toBe('# 標題\n');
    m.unmount();
  });
});

describe('MarkdownEditor images', () => {
  it('asks the host to resolve image src for display and keeps the Markdown unchanged', async () => {
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorHandle>();
    const original = '# 圖\n\n![桌面](assets/desk.jpg)\n';
    const resolveImage = vi.fn((src: string) =>
      Promise.resolve(`http://svc/media/v1/${src}?sig=1`),
    );
    const m = await mount(
      <MarkdownEditor
        ref={ref}
        markdown={original}
        onChange={onChange}
        resolveImage={resolveImage}
      />,
    );
    // MDXEditor suspends the <img> until it loads, which jsdom never does; the
    // rendered image is checked in the Electron acceptance run instead.
    await vi.waitFor(() => {
      expect(resolveImage).toHaveBeenCalled();
    });
    expect(resolveImage).toHaveBeenCalledWith('assets/desk.jpg');
    expect(ref.current?.getMarkdown()).toBe(original);
    expect(onChange).not.toHaveBeenCalled();
    m.unmount();
  });
});
