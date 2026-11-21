import { describe, expect, it, vi } from 'vitest';
import { MAX_VISIBLE, ToastQueue } from '../src/renderer/toasts.js';

const spec = (message: string, onClose = () => undefined) => ({ message, onClose });

describe('shared toast queue (QC-045 review)', () => {
  it('shows at most two, oldest on top and newest at the bottom', () => {
    const q = new ToastQueue();
    expect(MAX_VISIBLE).toBe(2);
    q.set('a', spec('一'));
    q.set('b', spec('二'));
    expect(q.getSnapshot().map((e) => e.message)).toEqual(['一', '二']);
    q.set('c', spec('三'));
    expect(q.getSnapshot().map((e) => e.message)).toEqual(['二', '三']);
    // The older one waits and comes back when a newer one goes.
    q.remove('c');
    expect(q.getSnapshot().map((e) => e.message)).toEqual(['一', '二']);
  });

  it('updates a toast in place without moving it', () => {
    const q = new ToastQueue();
    q.set('a', spec('一'));
    q.set('b', spec('二'));
    q.set('a', spec('一（更新）'));
    expect(q.getSnapshot().map((e) => e.message)).toEqual(['一（更新）', '二']);
  });

  it('refreshes callbacks without re-rendering, and the latest callback runs', () => {
    const q = new ToastQueue();
    const listener = vi.fn();
    q.subscribe(listener);
    const first = vi.fn();
    const second = vi.fn();
    q.set('a', spec('一', first));
    expect(listener).toHaveBeenCalledTimes(1);
    q.set('a', spec('一', second));
    expect(listener).toHaveBeenCalledTimes(1);
    q.all[0]?.onClose();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('removing an unknown toast does nothing', () => {
    const q = new ToastQueue();
    const listener = vi.fn();
    q.subscribe(listener);
    q.remove('nope');
    expect(listener).not.toHaveBeenCalled();
  });
});
