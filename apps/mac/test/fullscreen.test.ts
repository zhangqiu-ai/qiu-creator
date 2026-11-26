import { describe, expect, it } from 'vitest';
import { exitFullscreenOnEscape, type FullscreenDocument } from '../src/renderer/fullscreen.js';

function keyEvent(key: string, defaultPrevented = false) {
  const calls: string[] = [];
  return {
    calls,
    event: {
      key,
      defaultPrevented,
      preventDefault: () => calls.push('preventDefault'),
      stopImmediatePropagation: () => calls.push('stop'),
    },
  };
}

function fakeDoc(inFullscreen: boolean): FullscreenDocument & { exits: number } {
  const doc = {
    exits: 0,
    fullscreenElement: inFullscreen ? ({} as Element) : null,
    exitFullscreen: () => {
      doc.exits += 1;
      return Promise.resolve();
    },
  };
  return doc;
}

describe('Esc leaves video fullscreen (QC-104)', () => {
  it('exits fullscreen and keeps the key from closing what is underneath', () => {
    const doc = fakeDoc(true);
    const { event, calls } = keyEvent('Escape');
    expect(exitFullscreenOnEscape(event, doc)?.element).toBe(doc.fullscreenElement);
    expect(doc.exits).toBe(1);
    expect(calls).toEqual(['preventDefault', 'stop']);
  });

  it('leaves Esc alone when nothing is fullscreen', () => {
    const doc = fakeDoc(false);
    const { event, calls } = keyEvent('Escape');
    expect(exitFullscreenOnEscape(event, doc)).toBeNull();
    expect(doc.exits).toBe(0);
    expect(calls).toEqual([]);
  });

  it('ignores other keys and keys already handled', () => {
    const doc = fakeDoc(true);
    expect(exitFullscreenOnEscape(keyEvent(' ').event, doc)).toBeNull();
    expect(exitFullscreenOnEscape(keyEvent('Escape', true).event, doc)).toBeNull();
    expect(doc.exits).toBe(0);
  });
});
