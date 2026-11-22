import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-065 performance check: the library with 300 works with card pictures, motion on.
 * Not part of the e2e suite (own config: e2e/perf/playwright.perf.config.ts).
 *
 *   QC_E2E_MOTION=on QC_PERF_OUT=<dir> [CREATORHUB_E2E_APP=<…/MacOS/qiu-creator>] \
 *     pnpm exec playwright test --config=e2e/perf/playwright.perf.config.ts
 *
 * For each interaction it records, in the page: every requestAnimationFrame
 * timestamp (frame intervals, and frames counted as dropped when an interval is
 * more than 1.5 vsync intervals), long tasks (> 50 ms) and long animation frames;
 * over CDP: Performance.getMetrics deltas (script, layout, style) and a trace of
 * the compositor's frame reports (presented / dropped). The window stays hidden
 * (QC-064); see docs/evidence/qc065-perf.md for what that does to each number.
 */

const WORKS = 300;
const POSTS = 200;
const ARTICLES_WITH_IMAGE = 60;

const grid = (page: Page): Locator => page.getByRole('region', { name: '作品', exact: true });
const cards = (page: Page): Locator => grid(page).locator('.wcard');
const typeFilter = (page: Page, name: RegExp): Locator =>
  page.getByRole('group', { name: '類型' }).getByRole('button', { name });
const row = (page: Page, name: string): Locator =>
  page.locator('[data-project-row]', { hasText: name });

/** Page-side recorder, as a string: the e2e project has no DOM types. */
const RECORDER = `(() => {
  const w = window;
  if (w.__perf) return;
  const s = { on: false, frames: [], longTasks: [], loafs: [] };
  w.__perf = s;
  const tick = (t) => { if (s.on) s.frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  new PerformanceObserver((l) => { if (s.on) for (const e of l.getEntries()) s.longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask' });
  try {
    new PerformanceObserver((l) => { if (s.on) for (const e of l.getEntries()) s.loafs.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration, render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0, styleLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0, scripts: e.scripts.map((x) => x.invoker + ' ' + Math.round(x.duration)) }); }).observe({ type: 'long-animation-frame' });
  } catch { /* not supported */ }
})()`;

interface PageSample {
  frames: number[];
  longTasks: { start: number; duration: number }[];
  loafs: {
    start: number;
    duration: number;
    blocking: number;
    render: number;
    styleLayout: number;
    scripts: string[];
  }[];
}

type Metrics = Record<string, number>;

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const res = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(res.metrics.map((m) => [m.name, m.value]));
}

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  args?: { chrome_frame_reporter?: { state?: string; frame_type?: string } };
}

/** Starts a trace of frame reports; the returned function stops it and counts the states. */
async function startTrace(cdp: CDPSession): Promise<() => Promise<Record<string, number>>> {
  const events: TraceEvent[] = [];
  const onData = (e: { value: object[] }) => {
    events.push(...(e.value as TraceEvent[]));
  };
  cdp.on('Tracing.dataCollected', onData);
  await cdp.send('Tracing.start', {
    traceConfig: {
      includedCategories: [
        'disabled-by-default-devtools.timeline.frame',
        'cc',
        'benchmark',
        'devtools.timeline',
      ],
    },
    transferMode: 'ReportEvents',
  });
  return async () => {
    const done = new Promise<void>((resolve) => {
      cdp.once('Tracing.tracingComplete', () => {
        resolve();
      });
    });
    await cdp.send('Tracing.end');
    await done;
    cdp.off('Tracing.dataCollected', onData);
    const counts: Record<string, number> = {};
    for (const e of events) {
      const state = e.name === 'PipelineReporter' ? e.args?.chrome_frame_reporter?.state : null;
      if (state !== undefined && state !== null && e.ph === 'b')
        counts[state] = (counts[state] ?? 0) + 1;
      if (e.name === 'DroppedFrame') counts['DroppedFrame'] = (counts['DroppedFrame'] ?? 0) + 1;
      if (e.name === 'BeginFrame') counts['BeginFrame'] = (counts['BeginFrame'] ?? 0) + 1;
    }
    return counts;
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const round = (n: number): number => Math.round(n * 10) / 10;

interface Result {
  name: string;
  wallMs: number;
  frames: number;
  vsyncMs: number;
  intervalMs: { median: number; p95: number; p99: number; max: number };
  droppedByRaf: number;
  longTasks: { count: number; maxMs: number; totalMs: number };
  loafs: { count: number; maxMs: number; maxBlockingMs: number; detail: PageSample['loafs'] };
  cdp: { scriptMs: number; layoutMs: number; styleMs: number; taskMs: number; layouts: number };
  trace: Record<string, number>;
}

async function measure(
  page: Page,
  cdp: CDPSession,
  vsyncMs: number,
  name: string,
  action: () => Promise<void>,
): Promise<Result> {
  // Let anything still settling from the previous step finish first.
  await page.waitForTimeout(500);
  await page.evaluate(
    '(() => { const s = window.__perf; s.frames = []; s.longTasks = []; s.loafs = []; s.on = true; })()',
  );
  const before = await metrics(cdp);
  const stopTrace = await startTrace(cdp);
  const t0 = Date.now();
  await action();
  // Motion settles within `slow` (320 ms); keep recording through it.
  await page.waitForTimeout(400);
  const wallMs = Date.now() - t0;
  const trace = await stopTrace();
  const after = await metrics(cdp);
  const sample = await page.evaluate<PageSample>(
    '(() => { const s = window.__perf; s.on = false; return { frames: s.frames, longTasks: s.longTasks, loafs: s.loafs }; })()',
  );
  const intervals = sample.frames.slice(1).map((t, i) => t - (sample.frames[i] ?? t));
  const sorted = [...intervals].sort((a, b) => a - b);
  const delta = (k: string) => round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000);
  return {
    name,
    wallMs,
    frames: sample.frames.length,
    vsyncMs: round(vsyncMs),
    intervalMs: {
      median: round(pct(sorted, 50)),
      p95: round(pct(sorted, 95)),
      p99: round(pct(sorted, 99)),
      max: round(sorted.at(-1) ?? 0),
    },
    // Frames that should have been drawn in the gaps longer than 1.5 vsync intervals.
    droppedByRaf: intervals
      .filter((d) => d > vsyncMs * 1.5)
      .reduce((n, d) => n + Math.round(d / vsyncMs) - 1, 0),
    longTasks: {
      count: sample.longTasks.length,
      maxMs: round(Math.max(0, ...sample.longTasks.map((l) => l.duration))),
      totalMs: round(sample.longTasks.reduce((n, l) => n + l.duration, 0)),
    },
    loafs: {
      count: sample.loafs.length,
      maxMs: round(Math.max(0, ...sample.loafs.map((l) => l.duration))),
      maxBlockingMs: round(Math.max(0, ...sample.loafs.map((l) => l.blocking))),
      detail: sample.loafs,
    },
    cdp: {
      scriptMs: delta('ScriptDuration'),
      layoutMs: delta('LayoutDuration'),
      styleMs: delta('RecalcStyleDuration'),
      taskMs: delta('TaskDuration'),
      layouts: (after['LayoutCount'] ?? 0) - (before['LayoutCount'] ?? 0),
    },
    trace,
  };
}

/** Press, pass dnd-kit's 4 px threshold, glide over the target in `steps`, release. */
async function drag(page: Page, from: Locator, to: Locator, steps: number): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error('drag target not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 6, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
  await page.mouse.up();
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
}

test('作品庫 300 件效能（動效開啟）', async ({ desktop }) => {
  test.setTimeout(15 * 60_000);
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;

  // 300 works: 200 image posts, 60 articles with a picture, 40 text-only articles.
  const colors = ['#C2410C', '#0F766E', '#1D4ED8', '#A16207', '#7C3AED', '#BE185D'];
  const images: string[] = [];
  for (const [i, color] of colors.entries()) {
    const up = await c.assets.upload({
      data: await pngBytes(900, 600 + i * 40, color),
      filename: `perf-${String(i)}.png`,
    });
    images.push(up.asset.id);
  }
  const spring = await c.projects.create({ name: '春季選題', color: 1 });
  await c.projects.create({ name: '旅行', color: 2 });
  for (let i = 0; i < WORKS; i += 1) {
    const title = `效能作品 ${String(i + 1).padStart(3, '0')}`;
    const asset = images[i % images.length] ?? '';
    if (i < POSTS) {
      const w = await c.works.create({
        title,
        type: 'image',
        source: 'mac-app',
        ...(i % 5 === 0 ? { project_ids: [spring.id] } : {}),
      });
      await c.works.patch(w.id, { base_revision: w.current_revision_id, images: [asset] });
    } else if (i < POSTS + ARTICLES_WITH_IMAGE) {
      const w = await c.works.create({
        title,
        markdown: `# ${title}\n\n開頭。\n`,
        source: 'mac-app',
      });
      const { src } = await c.works.attachMedia(w.id, asset);
      const fresh = await c.works.get(w.id);
      await c.works.patch(w.id, {
        base_revision: fresh.current_revision_id,
        markdown: `# ${title}\n\n開頭。\n\n![圖](${src})\n`,
      });
    } else {
      await c.works.create({
        title,
        markdown: `# ${title}\n\n每天早上七點起床，先寫三百字再看手機。寫完之後泡一杯咖啡，把昨天的段落讀一遍。`,
        source: 'mac-app',
      });
    }
  }
  await page.reload();
  await expect(cards(page).first()).toBeVisible();
  const shown = await cards(page).count();
  const motion = await page.evaluate<string | undefined>('document.documentElement.dataset.motion');

  // Warm-up (not measured): a screen at a time, wait for the lazy card pictures on it to be
  // generated (the service makes 2 at a time) and decoded, so the runs below are warm.
  const scroller = page.locator('main.page');
  const pending = `(() => {
    const view = document.querySelector('main.page').getBoundingClientRect();
    return [...document.querySelectorAll('img.wcard__media')].filter((i) => {
      const r = i.getBoundingClientRect();
      return r.bottom > view.top && r.top < view.bottom && !(i.complete && i.naturalWidth > 0);
    }).length;
  })()`;
  const atBottom =
    '(() => { const el = document.querySelector("main.page"); return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; })()';
  await scroller.evaluate('(el) => { el.scrollTop = 0; }');
  for (let screen = 0; screen < 60; screen += 1) {
    await expect.poll(() => page.evaluate<number>(pending), { timeout: 60_000 }).toBe(0);
    if (await page.evaluate<boolean>(atBottom)) break;
    await scroller.evaluate('(el) => { el.scrollTop += el.clientHeight; }');
  }
  const pictures = await page.locator('img.wcard__media').count();
  await scroller.evaluate('(el) => { el.scrollTop = 0; }');

  await page.evaluate(RECORDER);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  // The frame interval with nothing going on: the vsync this window is driven at.
  await page.evaluate('(() => { const s = window.__perf; s.frames = []; s.on = true; })()');
  await page.waitForTimeout(1000);
  const idle = await page.evaluate<number[]>(
    '(() => { const s = window.__perf; s.on = false; return s.frames; })()',
  );
  const idleIntervals = idle
    .slice(1)
    .map((t, i) => t - (idle[i] ?? t))
    .sort((a, b) => a - b);
  const vsyncMs = pct(idleIntervals, 50);

  const results: Result[] = [];
  const box = await scroller.boundingBox();
  if (box === null) throw new Error('library not visible');

  results.push(
    await measure(page, cdp, vsyncMs, '捲動作品庫（滾輪到底再回頂）', async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 60; i += 1) {
        await page.mouse.wheel(0, 240);
        await page.waitForTimeout(16);
      }
      // The wheel really scrolled the hidden window: the grid's end is in view.
      expect(await page.evaluate<boolean>(atBottom)).toBe(true);
      for (let i = 0; i < 60; i += 1) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(16);
      }
    }),
  );

  // Counts per filter (not measured), so the measured run can wait for each change.
  const counts: Record<string, number> = {};
  for (const [key, name] of [
    ['posts', /貼圖/],
    ['articles', /文章/],
    ['all', /全部/],
  ] as const) {
    await typeFilter(page, name).click();
    await page.waitForTimeout(800);
    counts[key] = await cards(page).count();
  }
  results.push(
    await measure(page, cdp, vsyncMs, '切換篩選（貼圖→文章→全部，三輪）', async () => {
      for (let round = 0; round < 3; round += 1) {
        await typeFilter(page, /貼圖/).click();
        await expect(cards(page)).toHaveCount(counts['posts'] ?? 0);
        await typeFilter(page, /文章/).click();
        await expect(cards(page)).toHaveCount(counts['articles'] ?? 0);
        await typeFilter(page, /全部/).click();
        await expect(cards(page)).toHaveCount(counts['all'] ?? 0);
      }
    }),
  );

  results.push(
    await measure(page, cdp, vsyncMs, '多選（⌘ 點 30 張）與批量刪除', async () => {
      for (let i = 0; i < 30; i += 1)
        await cards(page)
          .nth(i)
          .click({ modifiers: ['Meta'] });
      await expect(page.getByRole('toolbar', { name: '已選 30 個' })).toBeVisible();
      await page.keyboard.press('Meta+Backspace');
      await page.getByRole('dialog').getByRole('button', { name: '刪除', exact: true }).click();
      await expect(cards(page)).toHaveCount(shown - 30);
    }),
  );

  results.push(
    await measure(page, cdp, vsyncMs, '全選（⌘A）再取消', async () => {
      await cards(page)
        .first()
        .click({ modifiers: ['Meta'] });
      await page.keyboard.press('Meta+a');
      await expect(page.getByRole('toolbar', { name: /^已選 \d+ 個$/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('toolbar', { name: /^已選/ })).toHaveCount(0);
    }),
  );

  results.push(
    await measure(page, cdp, vsyncMs, '拖卡片到項目（三次）', async () => {
      for (let i = 0; i < 3; i += 1) {
        await drag(page, cards(page).nth(i * 7 + 1), row(page, '旅行'), 30);
        await expect(row(page, '旅行')).toContainText(String(i + 1));
      }
    }),
  );

  const report = {
    at: new Date().toISOString(),
    app: process.env['CREATORHUB_E2E_APP'] ?? 'workspace electron',
    motion: motion ?? 'full',
    seeded: WORKS,
    shown,
    filterCounts: counts,
    pictures,
    vsyncMs: round(vsyncMs),
    idleIntervalMs: { p5: round(pct(idleIntervals, 5)), p95: round(pct(idleIntervals, 95)) },
    results,
  };
  const out = process.env['QC_PERF_OUT'] ?? test.info().outputDir;
  mkdirSync(out, { recursive: true });
  writeFileSync(
    path.join(out, `qc065-perf-${motion ?? 'full'}-${String(Date.now())}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
});
