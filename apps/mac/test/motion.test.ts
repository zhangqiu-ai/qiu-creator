import { describe, expect, it } from 'vitest';
import { motionPreference } from '../src/main/motion.js';
import { presetVariants, springOf, tween } from '../src/renderer/motion.js';
import { besidePointerAt } from '../src/renderer/projects-dnd.js';

describe('motion preference from the main process (QC-065)', () => {
  it('e2e runs with motion off unless recording asks for it', () => {
    expect(motionPreference({}, true, 'nominal')).toBe('off');
    expect(motionPreference({ CREATORHUB_MOTION: 'on' }, true, 'nominal')).toBe('auto');
    expect(motionPreference({ CREATORHUB_MOTION: 'off' }, false, 'nominal')).toBe('off');
  });

  it('a hot Mac gets the lite set; a cool one everything', () => {
    expect(motionPreference({}, false, 'nominal')).toBe('auto');
    expect(motionPreference({}, false, 'fair')).toBe('auto');
    expect(motionPreference({}, false, 'serious')).toBe('lite');
    expect(motionPreference({}, false, 'critical')).toBe('lite');
    expect(motionPreference({}, false, 'unknown')).toBe('auto');
    // Test mode wins over heat.
    expect(motionPreference({ CREATORHUB_MOTION: 'off' }, false, 'critical')).toBe('off');
  });
});

describe('motion presets (DESIGN.md 動效 · 各類互動)', () => {
  it('tweens and springs come from the tokens', () => {
    expect(tween('base')).toEqual({ type: 'tween', duration: 0.18, ease: [0.22, 1, 0.36, 1] });
    expect(tween('fast', 'in')).toEqual({ type: 'tween', duration: 0.12, ease: [0.4, 0, 1, 1] });
    expect(springOf('settle')).toEqual({ type: 'spring', visualDuration: 0.28, bounce: 0.12 });
  });

  it('a popover grows from its trigger: scale 0.96 and a 4 px nudge, base in, fast out', () => {
    const down = presetVariants({ kind: 'popover', origin: 'top right' }, 'full');
    expect(down['initial']).toEqual({ opacity: 0, scale: 0.96, y: -4 });
    expect(down['animate']).toMatchObject({
      opacity: 1,
      scale: 1,
      y: 0,
      transition: tween('base'),
    });
    expect(down['exit']).toEqual({ opacity: 0, transition: tween('fast', 'in') });
    const up = presetVariants({ kind: 'popover', origin: 'bottom left' }, 'full');
    expect(up['initial']).toMatchObject({ y: 4 });
  });

  it('dialogs, panels, toasts and list items follow their rows of the table', () => {
    expect(presetVariants({ kind: 'dialog' }, 'full')['animate']).toMatchObject({
      transition: tween('moderate'),
    });
    const panel = presetVariants({ kind: 'panel', from: 'right' }, 'full');
    expect(panel['initial']).toEqual({ opacity: 0, x: 24 });
    expect(panel['exit']).toMatchObject({ x: 24, transition: tween('base', 'in') });
    expect(presetVariants({ kind: 'toast' }, 'full')['initial']).toEqual({ opacity: 0, y: 8 });
    expect(presetVariants({ kind: 'contextMenu' }, 'full')['animate']).toMatchObject({
      transition: tween('instant'),
    });
    expect(presetVariants({ kind: 'listItem' }, 'full')['exit']).toMatchObject({ scale: 0.98 });
  });

  it('reduced and lite keep only a fast fade; test mode animates nothing', () => {
    for (const mode of ['reduced', 'lite'] as const) {
      const v = presetVariants({ kind: 'panel', from: 'left' }, mode);
      expect(v['initial']).toEqual({ opacity: 0 });
      expect(v['animate']).toEqual({ opacity: 1, transition: tween('fast') });
    }
    const off = presetVariants({ kind: 'dialog' }, 'off');
    expect(off['initial']).toEqual({ opacity: 1 });
    expect(off['animate']).toEqual({ opacity: 1, transition: { duration: 0 } });
  });
});

describe('the works drag copy rides beside the pointer', () => {
  it('moves the copy from the card corner to 12 px below-right of where it was grabbed', () => {
    expect(
      besidePointerAt(
        { x: 190, y: 295 },
        { left: 100, top: 200 },
        { x: 50, y: 30, scaleX: 1, scaleY: 1 },
      ),
    ).toEqual({ x: 50 + 90 + 12, y: 30 + 95 + 12, scaleX: 1, scaleY: 1 });
  });
});
