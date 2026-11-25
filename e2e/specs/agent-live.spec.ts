import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { createClient } from '../../packages/api-client/src/index.js';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';
import { editorSide } from '../fixtures/side.js';

/*
 * QC-097 (PT-20261125-001): agents at work, live. The first test sets exact
 * records through the e2e-only `window.qcAgentLive.set()` (AppInfo.e2e) to
 * reach every state and time; the second goes through the service (QC-096):
 * an agent token reports, the change stream pushes, the card follows.
 * - Cards: ring (sweep only in full motion, on screen, ≤ 12 working), agent
 *   tag (name, 「X 等 N 個」, step), skeleton before a cover, 剛完成 for 8 s,
 *   審閱提案／重試 static, 「N 分鐘沒有回報」 dashed.
 * - List: left bar (`data-live`) and the Agent column.
 * - Sidebar 「● N」 with its popover; header 「● N 個 Agent 工作中」.
 * - Editor: tab dot, the bar, and the yellow note while you type next to an
 *   agent that may edit text directly.
 * Test mode (motion off) never loops; QC_E2E_MOTION=on checks the sweep runs.
 * QC097_SHOTS=<dir> saves screenshots.
 */

const motionOn = process.env['QC_E2E_MOTION'] === 'on';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC097_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc097-${name}.png`) });
}

type Rec = {
  work_id: string;
  work_title?: string;
  project_ids?: string[];
  state: 'working' | 'done' | 'needs_attention' | 'error' | 'stale';
  agents: { token_id: string; name: string }[];
  step: string | null;
  /** How long ago, in ms; turned into updated_at in the page. */
  ago: number;
  counts?: { failed?: number; added?: number; removed?: number };
};

async function setLive(page: Page, records: Rec[]): Promise<void> {
  await page.evaluate(
    `window.qcAgentLive.set(${JSON.stringify(records)}.map(({ ago, ...r }) => ({ ...r, updated_at: new Date(Date.now() - ago).toISOString() })))`,
  );
}

const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const grid = (page: Page): Locator => page.getByRole('region', { name: '作品', exact: true });
const card = (page: Page, title: string): Locator =>
  grid(page).locator('.wcard', { hasText: title });

test('Agent 工作中：作品卡、列表、側欄、頁首、編輯頁', async ({ desktop }) => {
  test.setTimeout(120_000);
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  const project = await c.projects.create({ name: '創作助手' });
  const titles = [
    '京都秋季七日行程：從嵐山到伏見稻荷',
    '十坪書房改剪輯室，半年後的取捨',
    '一人食：15 分鐘番茄牛腩飯',
    '手沖入門：三款濾杯同豆對比',
    '台南兩天一夜小吃地圖',
    '秋冬通勤穿搭 5 套',
    '雨天在家的 10 個小練習',
  ];
  const works: Record<string, string> = {};
  for (const [i, title] of titles.entries()) {
    const w = await c.works.create({
      title,
      markdown: `# ${title}\n\n第一段。\n\n第二段。\n`,
      project_ids: [project.id],
    });
    // Every work but the first (still being made) gets a cover image.
    if (i > 0) {
      const asset = await c.assets.upload({
        data: await pngBytes(
          640,
          400,
          ['#3E4A57', '#9E4428', '#5B4033', '#B0621F', '#7A6B5A', '#6B7F5A'][i - 1] ?? '#555',
        ),
        filename: `c${String(i)}.png`,
      });
      const { src } = await c.works.attachMedia(w.id, asset.asset.id);
      const fresh = await c.works.get(w.id);
      await c.works.patch(w.id, {
        base_revision: fresh.current_revision_id,
        markdown: `# ${title}\n\n![](${src})\n\n第一段。\n\n第二段。\n`,
      });
    }
    works[title] = w.id;
  }
  const claude = backend.tokens.create({ name: 'Claude Code', scopes: ['read', 'propose'] });
  const codex = backend.tokens.create({ name: 'Codex', scopes: ['read', 'propose'] });
  const obsidian = backend.tokens.create({
    name: 'Obsidian 同步',
    scopes: ['read', 'write'],
    allow_direct_body_edit: true,
  });
  const cc = { token_id: claude.token.id, name: 'Claude Code' };
  const cx = { token_id: codex.token.id, name: 'Codex' };
  const ob = { token_id: obsidian.token.id, name: 'Obsidian 同步' };
  const id = (title: string): string => works[title] ?? '';
  const P = [project.id];
  const records: Rec[] = [
    {
      work_id: id(titles[0] ?? ''),
      work_title: titles[0],
      project_ids: P,
      state: 'working',
      agents: [cc],
      step: '配圖生成中',
      ago: 3_000,
    },
    {
      work_id: id(titles[1] ?? ''),
      work_title: titles[1],
      project_ids: P,
      state: 'working',
      agents: [cc, cx],
      step: '整理段落、補標籤',
      ago: 5_000,
    },
    {
      work_id: id(titles[2] ?? ''),
      project_ids: P,
      state: 'done',
      agents: [cx],
      step: '已新建並上傳 6 張圖片',
      ago: 6_500,
    },
    {
      work_id: id(titles[3] ?? ''),
      project_ids: P,
      state: 'needs_attention',
      agents: [cc],
      step: null,
      ago: 60_000,
      counts: { added: 3, removed: 1 },
    },
    {
      work_id: id(titles[4] ?? ''),
      project_ids: P,
      state: 'error',
      agents: [ob],
      step: '圖片下載失敗（2 張）',
      ago: 90_000,
      counts: { failed: 2 },
    },
    {
      work_id: id(titles[5] ?? ''),
      project_ids: P,
      state: 'working',
      agents: [cc],
      step: '寫結尾',
      ago: 3 * 60_000 + 5_000,
    },
  ];
  await page.reload();
  await setLive(page, records);

  await test.step('作品卡：工作中、多個 Agent、剛完成（8 秒後淡出）、需要你處理、出錯、可能已停止', async () => {
    const first = card(page, titles[0] ?? '');
    await expect(first).toHaveClass(/wcard--live-working/);
    await expect(first.getByRole('status', { name: 'Claude Code：配圖生成中' })).toBeVisible();
    // Still being made: a skeleton over the missing cover.
    await expect(first.locator('.lv-skel')).toHaveCount(1);
    await expect(
      card(page, titles[1] ?? '').getByRole('status', {
        name: 'Claude Code 等 2 個：整理段落、補標籤',
      }),
    ).toBeVisible();
    await expect(card(page, titles[1] ?? '').locator('.lv-skel')).toHaveCount(0);
    await expect(card(page, titles[3] ?? '').getByRole('status')).toHaveAccessibleName(
      'Claude Code：提案待審 · +3 −1',
    );
    await expect(
      card(page, titles[3] ?? '').getByRole('button', { name: '審閱提案' }),
    ).toBeVisible();
    await expect(
      card(page, titles[4] ?? '').getByRole('button', { name: '重試 2 項' }),
    ).toBeVisible();
    await expect(card(page, titles[5] ?? '').getByRole('status')).toHaveAccessibleName(
      'Claude Code：3 分鐘沒有回報',
    );
    await expect(card(page, titles[5] ?? '')).toHaveClass(/wcard--live-stale/);
    // Idle: no mark at all.
    await expect(card(page, titles[6] ?? '').locator('.lv-layer')).toHaveCount(0);
    if (motionOn) {
      // Full motion: the visible working card sweeps; the needs-you ones never move.
      await expect(first.locator('.lv-ring--anim')).toHaveCount(1);
      await expect(card(page, titles[3] ?? '').locator('.lv-ring--anim')).toHaveCount(0);
    } else {
      // Test mode: no loop anywhere.
      await expect(
        page.locator('.lv-ring--anim, .lv-anim, .lv-dot--anim, .lv-dots--anim'),
      ).toHaveCount(0);
    }
    await shot(page, 'grid');
    // 剛完成 goes 8 s after it was reported (6.5 s ago here).
    await expect(card(page, titles[2] ?? '')).toHaveClass(/wcard--live-done/);
    await expect(card(page, titles[2] ?? '')).not.toHaveClass(/wcard--live-done/, {
      timeout: 5_000,
    });
  });

  await test.step('頁首與側欄「● N」：點開列出 Agent 與作品，連到活動記錄', async () => {
    await nav(page)
      .getByRole('button', { name: /^創作助手/ })
      .click();
    await expect(page.locator('.lv-head')).toHaveText('2 個 Agent 工作中');
    const pill = nav(page).getByRole('button', { name: '2 個 Agent 工作中，查看是誰' });
    await expect(pill).toHaveCount(2);
    await pill.first().click();
    const pop = page.getByRole('dialog', { name: '正在工作' });
    await expect(pop.locator('.lv-pop__row')).toHaveCount(2);
    await expect(pop.locator('.lv-pop__row', { hasText: 'Claude Code' })).toContainText(
      `2 件 · ${titles[0] ?? ''}`,
    );
    await shot(page, 'sidebar-popover');
    await pop.getByRole('button', { name: 'Agent 活動記錄' }).click();
    await expect(page.getByRole('heading', { name: 'Agent 與 MCP', level: 1 })).toBeVisible();
  });

  await test.step('列表：左緣狀態條與 Agent 欄', async () => {
    await nav(page)
      .getByRole('button', { name: /^創作助手/ })
      .click();
    await page.getByRole('button', { name: '列表' }).click();
    await expect(page.getByRole('columnheader', { name: 'Agent' })).toBeVisible();
    const row = (title: string) => page.locator('tbody tr', { hasText: title });
    await expect(row(titles[0] ?? '')).toHaveAttribute('data-live', 'working');
    await expect(row(titles[3] ?? '')).toHaveAttribute('data-live', 'needs_attention');
    await expect(row(titles[4] ?? '')).toHaveAttribute('data-live', 'error');
    await expect(row(titles[6] ?? '')).not.toHaveAttribute('data-live');
    await shot(page, 'list');
    await page.getByRole('button', { name: '網格' }).click();
  });

  await test.step('審閱提案與重試：開提案收件匣、匯入任務', async () => {
    await card(page, titles[3] ?? '')
      .getByRole('button', { name: '審閱提案' })
      .click();
    await expect(page.getByRole('heading', { name: 'Agent 提案', level: 1 })).toBeVisible();
    await nav(page)
      .getByRole('button', { name: /^創作助手/ })
      .click();
    await card(page, titles[4] ?? '')
      .getByRole('button', { name: '重試 2 項' })
      .click();
    await expect(page.getByRole('heading', { name: '匯入任務', level: 1 })).toBeVisible();
  });

  await test.step('編輯頁：分頁呼吸點、提示條（只能提案）', async () => {
    await nav(page)
      .getByRole('button', { name: /^創作助手/ })
      .click();
    await card(page, titles[1] ?? '')
      .locator('.wcard__title')
      .click();
    await expect(
      page.getByRole('tab', { name: /十坪書房/ }).getByRole('img', { name: '有 Agent 正在處理' }),
    ).toBeVisible();
    const banner = page.locator('.tab-pane:not([hidden]) .lv-banner');
    await expect(banner).toContainText('Claude Code、Codex 正在處理這件作品');
    await expect(banner).toContainText('Claude Code：整理段落、補標籤');
    await expect(banner).toContainText('它們只能提案，不會直接改你的正文。');
    await shot(page, 'editor-propose');
  });

  await test.step('可直接改正文的 Agent 工作中、你同時打字：黃色提醒，看它改了什麼', async () => {
    await setLive(page, [
      ...records,
      {
        work_id: id(titles[1] ?? ''),
        project_ids: P,
        state: 'working',
        agents: [ob],
        step: '更新段落',
        ago: 2_000,
      },
    ]);
    const banner = page.locator('.tab-pane:not([hidden]) .lv-banner');
    await expect(banner).toContainText('Obsidian 同步 正在直接修改這件作品');
    await expect(banner).toHaveClass(/lv-banner--direct/);
    await page
      .locator('.tab-pane:not([hidden]) .qc-md-editor__content')
      .getByText('第二段。')
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type('補一句。');
    await expect(banner).toHaveClass(/lv-banner--typing/);
    await expect(banner).toContainText('你的修改先留在這個視窗');
    await shot(page, 'editor-direct-typing');
    await banner.getByRole('button', { name: '看它改了什麼' }).click();
    await expect(editorSide(page).getByRole('tab', { name: '歷史' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  await test.step('超過 12 件同時工作：外框改為靜態；深色與英文', async () => {
    await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    const many: Rec[] = [];
    for (const t of titles)
      many.push({
        work_id: id(t),
        project_ids: P,
        state: 'working',
        agents: [cc],
        step: '工作中',
        ago: 1_000,
      });
    // Thirteen working works (some are not shown; they still count).
    for (let i = 0; i < 6; i++)
      many.push({
        work_id: `ghost-${String(i)}`,
        state: 'working',
        agents: [cx],
        step: null,
        ago: 1_000,
      });
    await setLive(page, many);
    await expect(card(page, titles[0] ?? '')).toHaveClass(/wcard--live-working/);
    await expect(page.locator('.lv-ring--anim')).toHaveCount(0);
    await setLive(page, records);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'grid-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate("window.creatorhub.setLanguage('en')");
    // The grid region is named in English now: find the card by its title.
    await expect(
      page.locator('.wcard', { hasText: titles[1] ?? '' }).getByRole('status'),
    ).toHaveAccessibleName('Claude Code · 2 agents: 整理段落、補標籤');
    await shot(page, 'grid-en');
    await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
  });
});

test('Agent 工作中（服務端，QC-096）：Agent 回報 → 作品卡即時出現，完成後淡出，側欄計數', async ({
  desktop,
}) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  const work = await c.works.create({
    title: '嵐山竹林清晨拍攝筆記',
    markdown: '# 嵐山\n\n第一段。\n',
  });
  const agent = backend.tokens.create({ name: 'Claude Code', scopes: ['read', 'propose'] });
  const ac = createClient({ baseUrl: backend.baseUrl, token: agent.secret });
  await page.reload();
  const target = card(page, '嵐山竹林清晨拍攝筆記');
  await expect(target).toBeVisible();
  await expect(target.locator('.lv-layer')).toHaveCount(0);

  await ac.agents.report({ work_ids: [work.id], state: 'working', step: '整理段落' });
  await expect(target.getByRole('status', { name: 'Claude Code：整理段落' })).toBeVisible();
  await expect(
    nav(page).getByRole('button', { name: '1 個 Agent 工作中，查看是誰' }),
  ).toBeVisible();
  await expect(page.locator('.lv-head')).toHaveText('1 個 Agent 工作中');

  // Done without a step reads 「已完成」 whether or not the service keeps steps on done reports.
  await ac.agents.report({ work_ids: [work.id], state: 'done' });
  await expect(target).toHaveClass(/wcard--live-done/);
  await expect(target.getByRole('status', { name: 'Claude Code：已完成' })).toBeVisible();
  // The service holds done for 8 s, then pushes idle.
  await expect(target.locator('.lv-layer')).toHaveCount(0, { timeout: 12_000 });
  await expect(nav(page).getByRole('button', { name: /個 Agent 工作中/ })).toHaveCount(0);
});
