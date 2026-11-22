/**
 * Shared semantic design tokens for Electron (CSS variables) and, in phase
 * two, React Native (plain values).
 *
 * Source of truth: DESIGN.md「視覺基線（已核准 PT-20261116-001）」, direction
 * 「暖白克制」. Token names match that table; pages reference names only,
 * never literal values.
 */

export const COLOR_TOKENS = [
  'bg',
  'surface',
  'sunken',
  'ink',
  'ink2',
  'ink3',
  'line',
  'accent',
  'accentSoft',
  'onAccent',
  'ok',
  'okSoft',
  'warn',
  'warnSoft',
  'bad',
  'badSoft',
  'scrim',
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type ColorScheme = 'light' | 'dark';
export type ColorPalette = Readonly<Record<ColorToken, string>>;

/** Tokens whose value carries alpha (overlays); all others are opaque `#rrggbb`. */
export const TRANSLUCENT_TOKENS: readonly ColorToken[] = ['scrim'];

const light: ColorPalette = {
  bg: '#f6f5f1',
  surface: '#ffffff',
  sunken: '#efede7',
  ink: '#1c1b19',
  ink2: '#55524c',
  ink3: '#6b6862',
  line: '#e4e1d9',
  accent: '#2f4fcf',
  accentSoft: '#e9edfc',
  onAccent: '#ffffff',
  ok: '#1e7046',
  okSoft: '#e3f1e8',
  warn: '#8a5300',
  warnSoft: '#fbefd9',
  bad: '#b42318',
  badSoft: '#fbe7e4',
  scrim: 'rgba(28, 27, 25, 0.32)',
};

const dark: ColorPalette = {
  bg: '#161615',
  surface: '#1f1f1d',
  sunken: '#121211',
  ink: '#eceae4',
  ink2: '#b5b1a8',
  ink3: '#9c988f',
  line: '#33322f',
  accent: '#8ea2ff',
  accentSoft: '#232a47',
  onAccent: '#161615',
  ok: '#6ccb97',
  okSoft: '#183223',
  warn: '#e9b160',
  warnSoft: '#3a2b12',
  bad: '#ff8b7e',
  badSoft: '#3d1c18',
  scrim: 'rgba(0, 0, 0, 0.55)',
};

export const palettes: Readonly<Record<ColorScheme, ColorPalette>> = { light, dark };

export const SHADOW_TOKENS = ['shadowCard', 'shadowDialog'] as const;
export type ShadowToken = (typeof SHADOW_TOKENS)[number];

export const shadows: Readonly<Record<ColorScheme, Readonly<Record<ShadowToken, string>>>> = {
  light: {
    shadowCard: '0 1px 2px rgba(28, 27, 25, 0.06), 0 4px 16px rgba(28, 27, 25, 0.06)',
    shadowDialog: '0 24px 64px rgba(0, 0, 0, 0.24)',
  },
  dark: {
    shadowCard: '0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.3)',
    shadowDialog: '0 24px 64px rgba(0, 0, 0, 0.24)',
  },
};

/**
 * Inter is bundled with the app (never loaded from the network); the rest of
 * the stack covers CJK. `Inter Variable` is the bundled face's family name.
 */
export const fontFamily = {
  ui: '"Inter Variable", Inter, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif',
  mono: '"SF Mono", ui-monospace, Menlo, monospace',
} as const;

export interface TypeStyle {
  size: number;
  lineHeight?: number;
  weight: number;
}

/** Type scale from DESIGN.md (sizes in px). */
export const typeScale = {
  pageTitle: { size: 20, weight: 600 },
  dialogTitle: { size: 16, weight: 600 },
  cardTitle: { size: 14, lineHeight: 1.4, weight: 600 },
  body: { size: 13, lineHeight: 1.5, weight: 400 },
  caption: { size: 12, weight: 500 },
  docH1: { size: 28, lineHeight: 1.35, weight: 700 },
  docH2: { size: 19, weight: 600 },
  docBody: { size: 16, lineHeight: 1.85, weight: 400 },
  source: { size: 13.5, lineHeight: 1.8, weight: 400 },
} as const satisfies Record<string, TypeStyle>;

/** Long-form reading column. */
export const readingColumn = { maxWidth: 680, paddingX: 48 } as const;

/** 4px spacing base; the common steps used across the app. */
export const SPACE_UNIT = 4;
export const spaceSteps = [4, 6, 8, 10, 12, 16, 20, 24, 28] as const;
export function space(steps: number): number {
  return steps * SPACE_UNIT;
}

export const radius = {
  small: 4,
  control: 7,
  card: 10,
  panel: 14,
  pill: 999,
  segment: 8,
  segmentItem: 6,
} as const;

export const size = {
  button: 32,
  buttonInList: 30,
  segment: 28,
  chip: 22,
  navItem: 34,
  sidebar: 220,
  sidebarCollapsed: 60,
} as const;

/** Window widths (px) for the narrow layouts. */
export const breakpoints = {
  /** Below this the sidebar collapses to an icon column. */
  sidebarCollapse: 1180,
  /** Below this the sidebar stacks above the content. */
  sidebarStack: 800,
} as const;

/** Motion; all of it is switched off under Reduce Motion. */
export const motion = {
  // DESIGN.md 動效: hover is the `fast` token (120 ms, ease-out); was 150 ms ease.
  hover: { durationMs: 120, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  progress: { durationMs: 400, easing: 'ease' },
  skeleton: { durationMs: 1200, easing: 'ease-in-out' },
  spinner: { durationMs: 800, easing: 'linear' },
} as const;

/**
 * Motion tokens from DESIGN.md「動效」(QC-065): durations, curves, springs and
 * distances. Plain data, no animation library; `apps/mac` turns them into
 * motion and dnd-kit parameters, CSS reads the `--qc-dur-*` / `--qc-ease-*`
 * variables. Pages never write their own durations or curves.
 */
export const duration = {
  instant: 80,
  fast: 120,
  base: 180,
  moderate: 240,
  slow: 320,
  progress: 400,
} as const;
export type DurationToken = keyof typeof duration;

/** Cubic-bézier control points, for animation libraries that take numbers. */
export const easingCurve = {
  out: [0.22, 1, 0.36, 1],
  in: [0.4, 0, 1, 1],
  inOut: [0.45, 0, 0.25, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

const bezier = (c: readonly number[]): string => `cubic-bezier(${c.join(', ')})`;

/** The same curves as CSS timing functions. */
export const easing = {
  out: bezier(easingCurve.out),
  in: bezier(easingCurve.in),
  inOut: bezier(easingCurve.inOut),
  linear: 'linear',
} as const;
export type EasingToken = keyof typeof easing;

/** Springs by visual duration (seconds), so 60 Hz and 120 Hz feel the same; bounce ≤ 0.15. */
export const spring = {
  snappy: { visualDuration: 0.2, bounce: 0 },
  settle: { visualDuration: 0.28, bounce: 0.12 },
} as const;

export const motionDistance = { nudge: 4, rise: 8, panel: 24 } as const;
export const motionScale = { menu: 0.96, dialog: 0.97, lift: 1.02, dropInto: 0.6 } as const;
/** Pointer travel before a drag starts, so clicks stay clicks. */
export const DRAG_ACTIVATION_PX = 4;

/** `ink2` -> `--qc-ink2`, `accentSoft` -> `--qc-accent-soft` */
export function cssVarName(token: ColorToken | ShadowToken): string {
  return `--qc-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** `var(--qc-ink)` for use in style objects. */
export function cssVar(token: ColorToken | ShadowToken): string {
  return `var(${cssVarName(token)})`;
}

function declarations(scheme: ColorScheme): string {
  const colors = COLOR_TOKENS.map((t) => `  ${cssVarName(t)}: ${palettes[scheme][t]};`);
  const shadow = SHADOW_TOKENS.map((t) => `  ${cssVarName(t)}: ${shadows[scheme][t]};`);
  return [...colors, ...shadow].join('\n');
}

const indent = (text: string) => text.replace(/^/gm, '  ');

/**
 * Stylesheet that defines every token for light and dark appearance,
 * following `prefers-color-scheme` unless `data-theme` pins one.
 */
export function buildCssVariables(): string {
  const constants = [
    `  color-scheme: light dark;`,
    `  --qc-font-ui: ${fontFamily.ui};`,
    `  --qc-font-mono: ${fontFamily.mono};`,
    `  --qc-space: ${SPACE_UNIT}px;`,
    ...Object.entries(radius).map(
      ([k, v]) => `  --qc-radius-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v}px;`,
    ),
    `  --qc-motion-hover: ${motion.hover.durationMs}ms ${motion.hover.easing};`,
    `  --qc-motion-progress: ${motion.progress.durationMs}ms ${motion.progress.easing};`,
    ...Object.entries(duration).map(([k, v]) => `  --qc-dur-${k}: ${String(v)}ms;`),
    `  --qc-dur-skeleton: ${String(motion.skeleton.durationMs)}ms;`,
    `  --qc-dur-spinner: ${String(motion.spinner.durationMs)}ms;`,
    ...Object.entries(easing).map(
      ([k, v]) => `  --qc-ease-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v};`,
    ),
  ].join('\n');
  return [
    `:root {\n${constants}\n${declarations('light')}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {\n${indent(declarations('dark'))}\n  }\n}`,
    `:root[data-theme='dark'] {\n${declarations('dark')}\n}`,
  ].join('\n\n');
}
