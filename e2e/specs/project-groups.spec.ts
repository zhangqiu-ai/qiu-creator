import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { createClient } from '../../packages/api-client/src/index.js';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';
import { settleAfterDrop } from '../fixtures/dnd.js';

/*
 * QC-114 項目分組與系列 (PT-20261126-002 option A): a project page in
 * sections (未分組 first with its hint, a series numbered 第 N 集, an
 * agent's group marked), dragging works into a group and into a series at a
 * place, Esc cancelling, several works at once, a collapsed group opening
 * under a resting drag, dragging a header to reorder, 移到分組 ▸ (a series
 * says its episode, ＋ 新分組… makes one), the ⋯ menu (rename, 系列, move,
 * collapse others, delete), collapse remembered, live updates from an
 * agent, the list's 集 column, dark, and 全部作品's 「› 分組 #集數」.
 * Set QC114_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC114_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc114-${name}.png`) });
}

const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const body = (page: Page) => page.getByRole('region', { name: '作品', exact: true });
const section = (page: Page, name: string) =>
  body(page).locator('section.pgroup', {
    has: page.locator('.pgroup__name', { hasText: new RegExp(`^${name}$`) }),
  });
const ungrouped = (page: Page) => body(page).locator('[data-group-section="ungrouped"]');
const card = (scope: Locator, title: string) =>
  scope.locator('.wcard', { has: scope.page().locator('.wcard__title', { hasText: title }) });
const titles = (scope: Locator) => scope.locator('.wcard__title');
const sectionNames = (page: Page) => body(page).locator('.pgroup__head .pgroup__name');

/** Scroll the page so the section `key` (a group id) starts at the top: drags need both ends on screen. */
async function toTop(page: Page, key: string): Promise<void> {
  await page.evaluate(
    `document.querySelector('[data-group-section="${key}"]').scrollIntoView({ block: 'start' })`,
  );
}

async function center(target: Locator): Promise<{ x: number; y: number }> {
  const b = await target.boundingBox();
  if (b === null) throw new Error('not visible');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Pick up `from` with the pointer (past dnd-kit's threshold) and glide to `to`, still holding. */
async function pickUpAndHover(
  page: Page,
  from: Locator,
  to: { x: number; y: number },
): Promise<void> {
  const a = await center(from);
  // Both ends must be on screen, or the pointer leaves the window.
  const view = page.viewportSize();
  if (view !== null && (to.y < 0 || to.y > view.height || a.y < 0 || a.y > view.height))
    throw new Error(`drag ends off screen: ${JSON.stringify({ from: a, to })}`);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 12, a.y + 12, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 14 });
}

async function drop(page: Page, from: Locator, to: { x: number; y: number }): Promise<void> {
  await pickUpAndHover(page, from, to);
  await page.mouse.up();
  await settleAfterDrop(page);
}

test('項目分組與系列：分段、拖曳歸組與集數、選單、折疊、即時更新、列表、全部作品', async ({
  desktop,
}) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;

  const project = await c.projects.create({ name: '創作助手', color: 2 });
  const colors = [
    '#5F7F4A',
    '#B3462F',
    '#5B4A6E',
    '#7D8A49',
    '#2E3440',
    '#3B4A5A',
    '#5A4232',
    '#8C2F2A',
    '#A8641F',
    '#6B7F5A',
    '#7A6A55',
  ];
  const id: Record<string, string> = {};
  const make = async (key: string, title: string, i: number) => {
    const asset = (
      await c.assets.upload({
        data: await pngBytes(640, 400, colors[i] ?? '#777777'),
        filename: `${key}.png`,
      })
    ).asset;
    const work = await c.works.create({
      title,
      markdown: '',
      source: 'mac-app',
      project_ids: [project.id],
    });
    const { src } = await c.works.attachMedia(work.id, asset.id);
    const fresh = await c.works.get(work.id);
    await c.works.patch(work.id, {
      base_revision: fresh.current_revision_id,
      markdown: `# ${title}\n\n![](${src})\n`,
    });
    id[key] = work.id;
  };
  const seed: [string, string][] = [
    ['k1', '京都秋季七日行程：嵐山篇'],
    ['k2', '伏見稻荷：傍晚的千本鳥居'],
    ['k3', '鴨川夜散步與先斗町'],
    ['k4', '宇治抹茶半日'],
    ['g1', '剪輯室燈光：三盞燈的佈置'],
    ['g2', '十坪書房改剪輯室'],
    ['g3', '手沖入門：三款濾杯'],
    ['f1', '一人食：番茄牛腩飯'],
    ['f2', '一人食：親子丼'],
    ['u1', '雨天在家的 10 個小練習'],
    ['u2', '秋冬通勤穿搭 5 套'],
  ];
  for (const [i, [key, title]] of seed.entries()) await make(key, title, i);
  const w = (key: string): string => {
    const v = id[key];
    if (v === undefined) throw new Error(`no work ${key}`);
    return v;
  };
  const kyoto = await c.projects.createGroup(project.id, { name: '京都秋季系列', ordered: true });
  await c.projects.assignGroup(project.id, {
    work_ids: [w('k1'), w('k2'), w('k3'), w('k4')],
    group_id: kyoto.id,
  });
  const gear = await c.projects.createGroup(project.id, { name: '器材與工作室' });
  await c.projects.assignGroup(project.id, {
    work_ids: [w('g1'), w('g2'), w('g3')],
    group_id: gear.id,
  });
  // An agent makes a group: it carries the QC-091 Agent mark.
  const agentToken = backend.tokens.create({ name: 'Claude Code', scopes: ['read', 'write'] });
  const agent = createClient({ baseUrl: backend.baseUrl, token: agentToken.secret });
  const food = await agent.projects.createGroup(project.id, { name: '一人食' });
  await agent.projects.assignGroup(project.id, {
    work_ids: [w('f1'), w('f2')],
    group_id: food.id,
  });
  const groupsNow = async () => (await c.projects.get(project.id)).groups ?? [];
  const workIdsOf = async (groupId: string) =>
    (await groupsNow()).find((g) => g.id === groupId)?.work_ids;

  await page.reload();
  await nav(page).locator('[data-project-row]', { hasText: '創作助手' }).click();
  await expect(page.locator('.page__title')).toHaveText('創作助手');

  await test.step('同一頁分段：未分組在最上面附提示，系列標集數，Agent 建立有標記', async () => {
    await expect(sectionNames(page)).toHaveText([
      '未分組',
      '京都秋季系列',
      '器材與工作室',
      '一人食',
    ]);
    await expect(page.locator('main .page__sub')).toContainText('11 個作品 · 3 個分組');
    await expect(ungrouped(page).locator('.pgroup__hint')).toHaveText(
      '新作品先到這裡；拖到下面的分組，或右鍵「移到分組」',
    );
    await expect(ungrouped(page).locator('.pgroup__count')).toHaveText('2');
    // 未分組 cannot be renamed, deleted or moved: it has no ⋯.
    await expect(ungrouped(page).getByRole('button', { name: /選項/ })).toHaveCount(0);
    const series = section(page, '京都秋季系列');
    await expect(series.locator('.pgroup__series')).toHaveText('系列 · 4 集');
    await expect(titles(series)).toHaveText([
      '京都秋季七日行程：嵐山篇',
      '伏見稻荷：傍晚的千本鳥居',
      '鴨川夜散步與先斗町',
      '宇治抹茶半日',
    ]);
    await expect(series.locator('.wcard__ep')).toHaveText([
      '第 1 集',
      '第 2 集',
      '第 3 集',
      '第 4 集',
    ]);
    await expect(section(page, '一人食').locator('.pgroup__agent')).toHaveText('Claude Code 建立');
    await expect(section(page, '器材與工作室').locator('.wcard__ep')).toHaveCount(0);
    // Headers stay at the top while their section scrolls.
    await expect(series.locator('.pgroup__head')).toHaveCSS('position', 'sticky');
    await shot(page, '01-sections');
  });

  await test.step('拖進系列：插入線、虛線框、跟手標籤寫集數；放開後重排集數', async () => {
    const series = section(page, '京都秋季系列');
    const third = await card(series, '鴨川夜散步與先斗町').boundingBox();
    if (third === null) throw new Error('no card');
    await pickUpAndHover(page, card(ungrouped(page), '雨天在家'), {
      x: third.x + 12,
      y: third.y + third.height / 2,
    });
    await expect(series).toHaveClass(/pgroup--over/);
    await expect(series.locator('.pgroup__line')).toBeVisible();
    await expect(series.locator('.pgroup__drop')).toHaveText('放開以移到「京都秋季系列」');
    await expect(page.locator('.drag-hint')).toHaveText('移到 京都秋季系列 · 第 3 集');
    // The card left behind is faded.
    await expect(card(ungrouped(page), '雨天在家')).toHaveClass(/is-dragging/);
    await shot(page, '02-drag');
    await page.mouse.up();
    await settleAfterDrop(page);
    await expect(titles(series)).toHaveText([
      '京都秋季七日行程：嵐山篇',
      '伏見稻荷：傍晚的千本鳥居',
      '雨天在家的 10 個小練習',
      '鴨川夜散步與先斗町',
      '宇治抹茶半日',
    ]);
    await expect(card(series, '雨天在家').locator('.wcard__ep')).toHaveText('第 3 集');
    await expect(card(series, '鴨川').locator('.wcard__ep')).toHaveText('第 4 集');
    await expect(series.locator('.pgroup__series')).toHaveText('系列 · 5 集');
    await expect(ungrouped(page).locator('.pgroup__count')).toHaveText('1');
    expect(await workIdsOf(kyoto.id)).toEqual([w('k1'), w('k2'), w('u1'), w('k3'), w('k4')]);
    // The result is on screen: no toast.
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  await test.step('Esc 取消拖曳：什麼都不變', async () => {
    await pickUpAndHover(
      page,
      card(ungrouped(page), '秋冬通勤'),
      await center(section(page, '器材與工作室')),
    );
    await expect(section(page, '器材與工作室')).toHaveClass(/pgroup--over/);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settleAfterDrop(page);
    await expect(card(ungrouped(page), '秋冬通勤')).toBeVisible();
    await expect(section(page, '器材與工作室')).not.toHaveClass(/pgroup--over/);
    expect(await workIdsOf(gear.id)).toEqual([w('g1'), w('g2'), w('g3')]);
  });

  await test.step('多選一起拖到一般分組：放到最後', async () => {
    const gearSec = section(page, '器材與工作室');
    await card(gearSec, '剪輯室燈光').click({ modifiers: ['Meta'] });
    await card(gearSec, '十坪書房').click({ modifiers: ['Meta'] });
    await toTop(page, gear.id);
    await pickUpAndHover(
      page,
      card(gearSec, '剪輯室燈光'),
      await center(section(page, '一人食').locator('.pgroup__head')),
    );
    await expect(page.locator('.drag-hint')).toHaveText('移到 一人食');
    await expect(page.locator('.drag-ghost')).toHaveText('2 個作品');
    await page.mouse.up();
    await settleAfterDrop(page);
    await expect(section(page, '一人食').locator('.pgroup__count')).toHaveText('4');
    await expect(gearSec.locator('.pgroup__count')).toHaveText('1');
    // In the order the section shows them (newest first in a group that is not a series).
    expect(await workIdsOf(food.id)).toEqual([w('f1'), w('f2'), w('g2'), w('g1')]);
    await page.keyboard.press('Escape');
  });

  await test.step('右鍵 移到分組 ▸：系列寫「放到第 N 集」；未分組空了就不顯示', async () => {
    await card(ungrouped(page), '秋冬通勤').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '移到分組' }).hover();
    const toSeries = page.getByRole('menuitemradio', { name: /京都秋季系列/ });
    await expect(toSeries).toContainText('放到第 6 集');
    await expect(page.getByRole('menuitem', { name: '新分組…' })).toBeVisible();
    await shot(page, '03-move-menu');
    await toSeries.click();
    await expect(ungrouped(page)).toHaveCount(0);
    await expect(card(section(page, '京都秋季系列'), '秋冬通勤').locator('.wcard__ep')).toHaveText(
      '第 6 集',
    );
  });

  await test.step('子選單 ＋ 新分組…：建立後直接放入', async () => {
    await card(section(page, '京都秋季系列'), '宇治抹茶').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '移到分組' }).hover();
    await page.getByRole('menuitem', { name: '新分組…' }).click();
    const dialog = page.getByRole('dialog', { name: '新分組' });
    await dialog.getByLabel('分組名稱').fill('精選');
    await dialog.getByRole('checkbox', { name: /當作系列/ }).check();
    await dialog.getByRole('button', { name: '建立' }).click();
    const picks = section(page, '精選');
    await expect(card(picks, '宇治抹茶').locator('.wcard__ep')).toHaveText('第 1 集');
    await expect(section(page, '京都秋季系列').locator('.pgroup__series')).toHaveText(
      '系列 · 5 集',
    );
    await expect(sectionNames(page)).toHaveText(['京都秋季系列', '器材與工作室', '一人食', '精選']);
  });

  await test.step('鍵盤也能改集數：往前一集', async () => {
    const series = section(page, '京都秋季系列');
    await card(series, '秋冬通勤').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '往前一集' }).click();
    await expect(card(series, '秋冬通勤').locator('.wcard__ep')).toHaveText('第 4 集');
    await expect(card(series, '鴨川').locator('.wcard__ep')).toHaveText('第 5 集');
  });

  await test.step('⋯：重新命名、上移、當作系列', async () => {
    const more = (name: string) =>
      section(page, name).getByRole('button', { name: `「${name}」選項` });
    await more('器材與工作室').click();
    await expect(page.getByRole('menuitem', { name: /刪除分組/ })).toContainText('作品回到未分組');
    await shot(page, '04-group-menu');
    await page.getByRole('menuitem', { name: '重新命名' }).click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('器材');
    await page.keyboard.press('Enter');
    await expect(sectionNames(page)).toHaveText(['京都秋季系列', '器材', '一人食', '精選']);
    await more('器材').click();
    await page.getByRole('menuitem', { name: '上移' }).click();
    await expect(sectionNames(page)).toHaveText(['器材', '京都秋季系列', '一人食', '精選']);
    await more('器材').click();
    await expect(page.getByRole('menuitem', { name: '上移' })).toBeDisabled();
    await page.getByRole('menuitemcheckbox', { name: /當作系列/ }).click();
    await expect(section(page, '器材').locator('.pgroup__series')).toHaveText('系列 · 1 集');
    await expect(section(page, '器材').locator('.wcard__ep')).toHaveText('第 1 集');
    const saved = (await groupsNow()).find((g) => g.id === gear.id);
    expect(saved?.name).toBe('器材');
    expect(saved?.ordered).toBe(true);
    expect(saved?.sort_order).toBe(0);
  });

  await test.step('拖段首排序分組', async () => {
    await toTop(page, food.id);
    await drop(
      page,
      section(page, '精選').locator('.pgroup__name'),
      await center(section(page, '一人食').locator('.pgroup__head')),
    );
    await expect(sectionNames(page)).toHaveText(['器材', '京都秋季系列', '精選', '一人食']);
    expect(
      [...(await groupsNow())].sort((a, b) => a.sort_order - b.sort_order).map((g) => g.name),
    ).toEqual(['器材', '京都秋季系列', '精選', '一人食']);
  });

  await test.step('折疊其他分組：只留一行縮圖與前兩個標題；重新開啟後仍記得', async () => {
    await section(page, '京都秋季系列')
      .getByRole('button', { name: '「京都秋季系列」選項' })
      .click();
    await page.getByRole('menuitem', { name: '折疊其他分組' }).click();
    const foodSec = section(page, '一人食');
    await expect(foodSec.getByRole('button', { name: '折疊或展開「一人食」' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(foodSec.locator('.pgroup__thumb')).toHaveCount(4);
    await expect(foodSec.locator('.pgroup__titles')).toHaveText(
      '一人食：親子丼、一人食：番茄牛腩飯…',
    );
    await expect(foodSec.locator('.wcard')).toHaveCount(0);
    await expect(section(page, '京都秋季系列').locator('.wcard')).toHaveCount(5);
    await shot(page, '05-collapsed');
    await page.reload();
    await nav(page).locator('[data-project-row]', { hasText: '創作助手' }).click();
    await expect(section(page, '一人食').locator('.pgroup__collapsed')).toBeVisible();
    await expect(section(page, '京都秋季系列').locator('.wcard')).toHaveCount(5);
  });

  await test.step('拖到折疊的分組上停一下會展開，放下後在裡面', async () => {
    const foodSec = section(page, '一人食');
    await pickUpAndHover(
      page,
      card(section(page, '京都秋季系列'), '京都秋季七日'),
      await center(foodSec.locator('.pgroup__head')),
    );
    await expect(foodSec.getByRole('button', { name: '折疊或展開「一人食」' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await page.mouse.up();
    await settleAfterDrop(page);
    await expect(card(foodSec, '京都秋季七日')).toBeVisible();
    expect(await workIdsOf(food.id)).toContain(w('k1'));
  });

  await test.step('Agent 從外部建分組：畫面即時出現', async () => {
    const live = await agent.projects.createGroup(project.id, { name: '直播素材' });
    await agent.projects.assignGroup(project.id, { work_ids: [w('g3')], group_id: live.id });
    await expect(section(page, '直播素材').locator('.pgroup__agent')).toHaveText(
      'Claude Code 建立',
    );
    await expect(card(section(page, '直播素材'), '手沖入門')).toBeVisible();
  });

  await test.step('刪除分組：作品回到未分組', async () => {
    await section(page, '直播素材').getByRole('button', { name: '「直播素材」選項' }).click();
    await page.getByRole('menuitem', { name: /刪除分組/ }).click();
    const dialog = page.getByRole('dialog', { name: '刪除分組「直播素材」？' });
    await expect(dialog).toContainText('1 個作品會回到未分組，仍留在這個項目裡。');
    await dialog.getByRole('button', { name: '刪除分組' }).click();
    await expect(section(page, '直播素材')).toHaveCount(0);
    // 未分組 was folded by 折疊其他分組: the work shows in its one-line view.
    await expect(ungrouped(page)).toContainText('手沖入門');
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  await test.step('列表：分組是段落列，系列有「集」欄', async () => {
    await page.getByRole('button', { name: '列表' }).click();
    const table = body(page).locator('table.tbl');
    await expect(table.getByRole('columnheader', { name: '集' })).toBeVisible();
    const seriesRows = table.locator('tbody', {
      has: page.locator('.pgroup__name', { hasText: /^京都秋季系列$/ }),
    });
    await expect(seriesRows.locator('.tbl__ep').first()).toHaveText('第 1 集');
    await expect(table.locator('.tbl__group .pgroup__name')).toHaveText([
      '未分組',
      '器材',
      '京都秋季系列',
      '精選',
      '一人食',
    ]);
    await shot(page, '06-list');
    await page.getByRole('button', { name: '網格' }).click();
  });

  await test.step('深色', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate('document.querySelector(".page")?.scrollTo(0, 0)');
    await shot(page, '07-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await test.step('全部作品：不分段，項目標籤後淡字「› 分組 #集數」', async () => {
    await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    await expect(body(page).locator('.pgroup')).toHaveCount(0);
    const label = card(body(page), '鴨川夜散步').locator('.plabel');
    await expect(label.locator('.plabel__name')).toHaveText('創作助手');
    await expect(label.locator('.plabel__group')).toHaveText('›京都秋季系列#4');
    await expect(label).toHaveAttribute('title', '創作助手 › 京都秋季系列 #4');
    await expect(card(body(page), '剪輯室燈光').locator('.plabel__group')).toHaveText('›一人食');
    await expect(card(body(page), '手沖入門').locator('.plabel__group')).toHaveCount(0);
    await shot(page, '08-all-works');
  });
});
