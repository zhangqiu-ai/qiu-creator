import { describe, expect, it } from 'vitest';
import { cutSourceOffset, liveBody } from '../src/renderer/preview/derive.js';
import {
  blockAt,
  clampPan,
  clampSplit,
  DEFAULT_PREFS,
  loadPreviewPrefs,
  pinchZoom,
  restingPan,
  savePreviewPrefs,
  scaleFor,
  stepZoom,
  zoomKey,
} from '../src/renderer/preview/preview-prefs.js';

/** QC-084: zoom, split width, remembered choices, follow and the live body (pure parts). */

function memory(): {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
} {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe('zoom', () => {
  it('fits height by default and fills the width on request', () => {
    const stage = { w: 520, h: 800 };
    expect(scaleFor({ kind: 'fit-height' }, stage)).toBeCloseTo((800 - 48 - 76) / 844);
    expect(scaleFor({ kind: 'fit-width' }, stage)).toBeCloseTo((520 - 40) / 390);
    expect(scaleFor({ kind: 'percent', percent: 150 }, stage)).toBe(1.5);
    expect(scaleFor({ kind: 'percent', percent: 999 }, stage)).toBe(3);
  });

  it('⌘＋／⌘－ step through 50, 75, 100 and 150 from the current scale', () => {
    expect(stepZoom(0.72, 1)).toEqual({ kind: 'percent', percent: 75 });
    expect(stepZoom(0.75, 1)).toEqual({ kind: 'percent', percent: 100 });
    expect(stepZoom(0.72, -1)).toEqual({ kind: 'percent', percent: 50 });
    expect(stepZoom(1.5, 1)).toEqual({ kind: 'percent', percent: 300 });
    expect(stepZoom(0.5, -1)).toEqual({ kind: 'percent', percent: 25 });
  });

  it('pinching follows the fingers within the bounds', () => {
    const z = pinchZoom(1, -20);
    expect(z.kind === 'percent' && z.percent > 100).toBe(true);
    expect(pinchZoom(0.25, 500)).toEqual({ kind: 'percent', percent: 25 });
  });

  it('reads ⌘0, ⌘＋ and ⌘－ only', () => {
    const k = (key: string, metaKey = true) =>
      zoomKey({ key, metaKey, ctrlKey: false, altKey: false });
    expect(k('0')).toBe('fit');
    expect(k('=')).toBe('in');
    expect(k('+')).toBe('in');
    expect(k('-')).toBe('out');
    expect(k('0', false)).toBeNull();
    expect(k('k')).toBeNull();
  });

  it('keeps part of a zoomed phone inside the stage when panning', () => {
    expect(clampPan({ x: 999, y: -999 }, { w: 585, h: 1266 }, { w: 520, h: 800 })).toEqual({
      x: 72.5,
      y: -309,
    });
    expect(clampPan({ x: 50, y: 50 }, { w: 300, h: 600 }, { w: 520, h: 800 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe('a phone taller than the stage', () => {
  it('rests with its top just under the screen tabs, and can be panned back there', () => {
    const stage = { w: 520, h: 780 };
    // 100%: 844 tall in 780 − 48 − 76 = 656 of room → 94 down from centred, top at 48.
    const rest = restingPan({ w: 390, h: 844 }, stage);
    expect(rest).toEqual({ x: 0, y: 94 });
    expect(clampPan(rest, { w: 390, h: 844 }, stage)).toEqual(rest);
    // A phone that fits stays centred.
    expect(restingPan({ w: 303, h: 656 }, stage)).toEqual({ x: 0, y: 0 });
  });
});

describe('split and remembered choices', () => {
  it('clamps the width to 400–720', () => {
    expect(clampSplit(100)).toBe(400);
    expect(clampSplit(900)).toBe(720);
    expect(clampSplit(Number.NaN)).toBe(520);
  });

  it('defaults to fit height, 刷到時, follow on, 520 wide; remembers changes', () => {
    const store = memory();
    expect(loadPreviewPrefs(store)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toMatchObject({
      width: 520,
      screen: 'feed',
      follow: true,
      collapsed: false,
    });
    savePreviewPrefs(store, {
      width: 999,
      collapsed: true,
      zoom: { kind: 'percent', percent: 150 },
      screen: 'body',
      follow: false,
    });
    expect(loadPreviewPrefs(store)).toEqual({
      width: 720,
      collapsed: true,
      zoom: { kind: 'percent', percent: 150 },
      screen: 'body',
      follow: false,
    });
  });

  it('falls back to the defaults on broken storage', () => {
    const store = memory();
    store.setItem('qc.preview.v2', '{nope');
    expect(loadPreviewPrefs(store)).toEqual(DEFAULT_PREFS);
    expect(loadPreviewPrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

describe('live body', () => {
  const md = '# 標題\n\n第一段文字。\n\n![](assets/a.png)\n\n## 小標\n\n第二段。\n';

  it('drops the title heading and follows the caret block', () => {
    const { phone } = liveBody(md, 'xiaohongshu', { title: '標題' });
    expect(phone.text.startsWith('第一段文字。')).toBe(true);
    const second = md.indexOf('第二段');
    const i = blockAt(phone.blocks, second + 1);
    expect(i === null ? null : phone.blocks[i]?.text).toBe('第二段。');
  });

  it('puts resolved images between article blocks for 公眾號', () => {
    const { phone } = liveBody(md, 'wechat_mp', { title: '標題' }, (src) => `media://${src}`);
    const kinds = phone.blocks.map((b) => b.kind);
    expect(kinds).toContain('image');
    expect(phone.blocks.find((b) => b.kind === 'image')?.src).toBe('media://assets/a.png');
    expect(kinds.indexOf('image')).toBeLessThan(kinds.indexOf('heading'));
  });

  it('marks where an over-long body is cut and finds that place in the source', () => {
    const long = `# T\n\n${'字'.repeat(1200)}\n`;
    const body = liveBody(long, 'xiaohongshu', { title: 'T' });
    expect(body.phone).toMatchObject({ length: 1200, limit: 1000, cutAt: 1000 });
    expect(cutSourceOffset(body)).toBe(long.indexOf('字') + 1000);
    expect(cutSourceOffset(liveBody('# T\n\nshort\n', 'xiaohongshu', { title: 'T' }))).toBeNull();
  });

  it('公眾號 summary and count use the visible text, not image syntax (QC-084 pre-release)', () => {
    const { phone } = liveBody(md, 'wechat_mp', { title: '標題' }, (src) => `media://${src}`);
    expect(phone.text).not.toContain('![');
    expect(phone.text).toBe('第一段文字。\n\n小標\n\n第二段。');
    expect(phone.length).toBe(16);
    // The body screen still shows the image, and blocks point into the counted text.
    expect(phone.blocks.find((b) => b.kind === 'image')).toBeDefined();
    const second = phone.blocks.find((b) => b.text === '第二段。');
    expect(second?.at).toBe(phone.text.indexOf('第二段'));
  });
});
