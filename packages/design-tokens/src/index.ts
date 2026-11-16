/**
 * Shared semantic design tokens for Electron (CSS variables) and, in phase
 * two, React Native (plain values).
 *
 * The visual direction is NOT approved yet (DESIGN.md "視覺基線（待確認）").
 * Until it is, every value below is a placeholder that mirrors the platform's
 * own system defaults (macOS / iOS system colors and fonts). Pages must only
 * reference token names, never literal values, so the approved palette can be
 * swapped in here without touching UI code.
 */

export const COLOR_TOKENS = [
  'canvas',
  'surface',
  'surfaceSelected',
  'textPrimary',
  'textSecondary',
  'textTertiary',
  'separator',
  'accent',
  'onAccent',
  'success',
  'warning',
  'danger',
  'focusRing',
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type ColorScheme = 'light' | 'dark';
export type ColorPalette = Readonly<Record<ColorToken, string>>;

/** Placeholder: Apple system colors (light appearance). */
const light: ColorPalette = {
  canvas: '#ffffff',
  surface: '#f5f5f7',
  surfaceSelected: '#e3e3e8',
  textPrimary: '#1d1d1f',
  textSecondary: '#5e5e63',
  textTertiary: '#8a8a8e',
  separator: '#d2d2d7',
  accent: '#0068d6',
  onAccent: '#ffffff',
  success: '#1f7a35',
  warning: '#8a5a00',
  danger: '#c4271c',
  focusRing: '#0068d6',
};

/** Placeholder: Apple system colors (dark appearance). */
const dark: ColorPalette = {
  canvas: '#1e1e1e',
  surface: '#2a2a2c',
  surfaceSelected: '#3a3a3c',
  textPrimary: '#f5f5f7',
  textSecondary: '#aeaeb2',
  textTertiary: '#8e8e93',
  separator: '#3d3d40',
  accent: '#3d9bff',
  // White on this blue is only 2.9:1; a light accent needs dark text on fills.
  onAccent: '#0a0a0a',
  success: '#4cd964',
  warning: '#ffcc33',
  danger: '#ff6b5e',
  focusRing: '#3d9bff',
};

export const palettes: Readonly<Record<ColorScheme, ColorPalette>> = { light, dark };

/** System font stacks (SF Pro + PingFang via the platform default). */
export const fontFamily = {
  ui: 'system-ui, -apple-system, "PingFang TC", "PingFang SC", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
} as const;

/** 4px spacing base from DESIGN.md. */
export const SPACE_UNIT = 4;
export function space(steps: number): number {
  return steps * SPACE_UNIT;
}

/** `textPrimary` -> `--qc-text-primary` */
export function cssVarName(token: ColorToken): string {
  return `--qc-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** `var(--qc-text-primary)` for use in style objects. */
export function cssVar(token: ColorToken): string {
  return `var(${cssVarName(token)})`;
}

function declarations(palette: ColorPalette): string {
  return COLOR_TOKENS.map((t) => `  ${cssVarName(t)}: ${palette[t]};`).join('\n');
}

/**
 * Stylesheet that defines every token for light and dark appearance, following
 * `prefers-color-scheme` unless `data-theme` pins one.
 */
export function buildCssVariables(): string {
  return [
    `:root {\n  color-scheme: light dark;\n  --qc-font-ui: ${fontFamily.ui};\n  --qc-font-mono: ${fontFamily.mono};\n  --qc-space: ${SPACE_UNIT}px;\n${declarations(light)}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {\n${declarations(dark).replace(/^/gm, '  ')}\n  }\n}`,
    `:root[data-theme='dark'] {\n${declarations(dark)}\n}`,
  ].join('\n\n');
}
