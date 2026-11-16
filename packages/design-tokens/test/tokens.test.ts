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

  it('maps token names to kebab-case CSS variables', () => {
    expect(cssVarName('textPrimary')).toBe('--qc-text-primary');
    expect(cssVar('focusRing')).toBe('var(--qc-focus-ring)');
  });

  it('emits light, dark and pinned-theme blocks', () => {
    const css = buildCssVariables();
    expect(css).toContain('--qc-canvas: #f5f5f7;');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain(":root[data-theme='dark']");
  });

  it('keeps body text and status colors at WCAG AA on canvas and surface', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const p = palettes[scheme];
      for (const bg of [p.canvas, p.surface]) {
        for (const fg of [
          p.textPrimary,
          p.textSecondary,
          p.danger,
          p.success,
          p.warning,
          p.accent,
        ]) {
          expect(contrast(fg, bg), `${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(p.onAccent, p.accent), `${scheme} onAccent`).toBeGreaterThanOrEqual(3);
      // Status text on its own soft fill (chips, banners, diff marks).
      for (const [fg, bg] of [
        [p.accent, p.accentSoft],
        [p.success, p.successSoft],
        [p.warning, p.warningSoft],
        [p.danger, p.dangerSoft],
        [p.textPrimary, p.surfaceSunken],
        [p.textSecondary, p.surfaceSunken],
      ] as const) {
        expect(contrast(fg, bg), `${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
