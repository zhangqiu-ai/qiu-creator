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

  it('opens lossy documents in source mode and keeps their text byte-for-byte', async () => {
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorHandle>();
    const original = fixture('lossy.md');
    const m = await mount(<MarkdownEditor ref={ref} markdown={original} onChange={onChange} />);
    expect(ref.current?.getMode()).toBe('source');
    const ta = m.container.querySelector('textarea');
    expect(ta?.value).toBe(original);

    const edited = `${original}\n補一句。\n`;
    act(() => {
      if (ta) setTextareaValue(ta, edited);
    });
    expect(onChange).toHaveBeenLastCalledWith(edited);
    m.unmount();
  });

  it('asks before switching a lossy document to the visual editor', async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const m = await mount(
      <MarkdownEditor ref={ref} markdown={fixture('lossy.md')} onChange={vi.fn()} />,
    );
    const visualButton = [...m.container.querySelectorAll('button')].find(
      (b) => b.textContent === '視覺',
    );
    act(() => {
      visualButton?.click();
    });
    expect(ref.current?.getMode()).toBe('source');
    expect(m.container.querySelector('[role="alertdialog"]')?.textContent).toContain('HTML');

    const cancel = [...m.container.querySelectorAll('button')].find(
      (b) => b.textContent === '取消',
    );
    act(() => {
      cancel?.click();
    });
    expect(m.container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(ref.current?.getMode()).toBe('source');
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
