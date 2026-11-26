import { describe, expect, it } from 'vitest';
import {
  countWords,
  nextAfterRemoval,
  thumbTime,
  viewable,
  viewerKeyAction,
  type ViewerKeyContext,
  type ViewerKeyEvent,
} from '../src/renderer/asset-viewer.js';

const key = (k: string, mods: Partial<ViewerKeyEvent> = {}): ViewerKeyEvent => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...mods,
});
const ctx = (over: Partial<ViewerKeyContext> = {}): ViewerKeyContext => ({
  typing: false,
  onControl: false,
  infoOpen: false,
  video: false,
  ...over,
});

describe('gallery view keys (QC-108 keys table)', () => {
  it('← → move, ↑ ↓ are not bound', () => {
    expect(viewerKeyAction(key('ArrowLeft'), ctx())).toBe('prev');
    expect(viewerKeyAction(key('ArrowRight'), ctx())).toBe('next');
    expect(viewerKeyAction(key('ArrowUp'), ctx())).toBeNull();
    expect(viewerKeyAction(key('ArrowDown'), ctx())).toBeNull();
  });

  it('Esc closes the info card first, then goes back to the grid', () => {
    expect(viewerKeyAction(key('Escape'), ctx({ infoOpen: true }))).toBe('closeInfo');
    expect(viewerKeyAction(key('Escape'), ctx())).toBe('back');
    // Even from a field of the card.
    expect(viewerKeyAction(key('Escape'), ctx({ infoOpen: true, typing: true }))).toBe('closeInfo');
  });

  it('I toggles the info card; F is full screen for videos only', () => {
    expect(viewerKeyAction(key('i'), ctx())).toBe('info');
    expect(viewerKeyAction(key('I'), ctx())).toBe('info');
    expect(viewerKeyAction(key('f'), ctx({ video: true }))).toBe('fullscreen');
    expect(viewerKeyAction(key('f'), ctx())).toBeNull();
  });

  it('Space plays or opens the preview, but not on a button or player', () => {
    expect(viewerKeyAction(key(' '), ctx())).toBe('space');
    expect(viewerKeyAction(key(' '), ctx({ onControl: true }))).toBeNull();
  });

  it('leaves keys alone while typing, composing, with modifiers or already handled', () => {
    expect(viewerKeyAction(key('ArrowLeft'), ctx({ typing: true }))).toBeNull();
    expect(viewerKeyAction(key('i'), ctx({ typing: true }))).toBeNull();
    expect(viewerKeyAction(key('ArrowRight', { isComposing: true }), ctx())).toBeNull();
    expect(viewerKeyAction(key('ArrowRight', { metaKey: true }), ctx())).toBeNull();
    expect(viewerKeyAction(key('ArrowRight', { shiftKey: true }), ctx())).toBeNull();
    expect(viewerKeyAction(key('Escape', { defaultPrevented: true }), ctx())).toBeNull();
  });
});

describe('after a delete in the view (檢視中刪除後跳到下一個)', () => {
  it('goes to the next asset, else the previous, else back to the grid', () => {
    expect(nextAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c');
    expect(nextAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b');
    expect(nextAfterRemoval(['a'], 'a')).toBeNull();
    expect(nextAfterRemoval(['a', 'b'], 'x')).toBeNull();
  });
});

describe('Markdown word count for the info line', () => {
  it('counts CJK characters one each and Latin words as words, not marks', () => {
    expect(countWords('# 嵐山\n\n清晨的竹林')).toBe(7);
    expect(countWords('**Hello** world, it’s 2026')).toBe(4);
    expect(countWords('[連結](https://example.com) 與 ![圖](a.png)')).toBe(4);
  });

  it('leaves out front matter and code blocks', () => {
    expect(countWords('---\ntitle: 很長的標題\n---\n正文')).toBe(2);
    expect(countWords('前\n\n```js\nconst x = 1;\n```\n\n後')).toBe(2);
  });
});

describe('video card frames and kinds', () => {
  it('takes the frame at 1 s, or half of a shorter clip', () => {
    expect(thumbTime(null)).toBe(1);
    expect(thumbTime(8)).toBe(1);
    expect(thumbTime(1.2)).toBe(0.6);
    expect(thumbTime(0)).toBe(1);
    expect(thumbTime(Number.NaN)).toBe(1);
  });

  it('shows pictures, players and text large; other files as an icon', () => {
    expect(viewable({ kind: 'image' })).toBe(true);
    expect(viewable({ kind: 'markdown' })).toBe(true);
    expect(viewable({ kind: 'other' })).toBe(false);
  });
});
