import { describe, expect, it } from 'vitest';
import {
  buildCssVariables,
  COLOR_TOKENS,
  cssVar,
  cssVarName,
  palettes,
  TRANSLUCENT_TOKENS,
} from '../src/index.js';

/** WCAG relative luminance contrast for #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens', () => {
  it('defines every token in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const token of COLOR_TOKENS) {
        expect(palettes[scheme][token]).toMatch(
          TRANSLUCENT_TOKENS.includes(token) ? /^rgba\(/ : /^#[0-9a-f]{6}$/,
        );
      }
    }
  });

  it('uses the approved 暖白克制 values from DESIGN.md', () => {
    expect(palettes.light).toMatchObject({ bg: '#f6f5f1', ink: '#1c1b19', accent: '#2f4fcf' });
    expect(palettes.dark).toMatchObject({ bg: '#161615', ink: '#eceae4', accent: '#8ea2ff' });
  });

  it('maps token names to kebab-case CSS variables', () => {
    expect(cssVarName('ink2')).toBe('--qc-ink2');
    expect(cssVarName('accentSoft')).toBe('--qc-accent-soft');
    expect(cssVar('shadowCard')).toBe('var(--qc-shadow-card)');
  });

  it('emits light, dark and pinned-theme blocks with radius and motion constants', () => {
    const css = buildCssVariables();
    expect(css).toContain('--qc-bg: #f6f5f1;');
    expect(css).toContain('--qc-radius-control: 7px;');
    expect(css).toContain('--qc-motion-hover: 150ms ease;');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain(":root[data-theme='dark']");
  });

  it('keeps text on bg/surface/sunken and status colors on their soft fill at WCAG AA (min 4.74)', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const p = palettes[scheme];
      const pairs: [string, string][] = [];
      for (const bg of [p.bg, p.surface, p.sunken]) {
        for (const fg of [p.ink, p.ink2, p.ink3]) pairs.push([fg, bg]);
      }
      pairs.push(
        [p.accent, p.accentSoft],
        [p.ok, p.okSoft],
        [p.warn, p.warnSoft],
        [p.bad, p.badSoft],
        [p.onAccent, p.accent],
      );
      for (const [fg, bg] of pairs) {
        expect(contrast(fg, bg), `${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.74);
      }
    }
  });
});
