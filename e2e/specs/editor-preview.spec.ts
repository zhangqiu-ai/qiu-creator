import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { ok } from '../../services/mac-server/test/fake-ai.js';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-085 作品編輯頁右側邊欄 (PT-20261123-002 A) around QC-084 平台預覽 v2
 * (PT-20261123-001). The sidebar runs from the window's top to its bottom,
 * its tab bar level with the work tabs; tabs 預覽, AI, 歷史, 素材 replace the
 * mutually exclusive buttons. ⌥⌘0 shows or hides it, ⌘⇧P 預覽, ⌘⇧I 素材 (also
 * in the menu bar); collapsed it is a 44 px icon rail; resize 400–760,
 * double-click 520, remembered for the window; under a 560 px editor column
 * it is a drawer over the text.
 * Inside 預覽: three screens per platform — 發布編輯 (title, cover, image
 * order and tags edited in place), 刷到時 and 正文 (read-only) — by tabs,
 * swipes or ←／→. The body follows the unsaved draft; overrides are 「自訂」
 * until 改回跟隨原稿. Zoom sits right of the screen tabs (fit height by
 * default, ⌘0／⌘＋／⌘－ while in the stage), never over the phone.
 * Both AI providers are local fakes; nothing leaves the machine.
 * QC085_SHOTS=<dir> saves screenshots.
 */

const IMAGE_MODEL = 'gpt-image-1';
const TITLE = '我把書房改成剪輯室：半年後的取捨';
const PARAS = [
  '今年三月，我把十坪的書房改成剪輯室。原本以為只是換張桌子、多買兩個螢幕，結果半年下來，改動最多的反而是光。',
  '白天的採光太強，螢幕上的顏色每個小時都在變。最後的做法是把窗戶完全遮住，改用兩盞可以調色溫的平板燈，固定在 5600K。',
  '書房原本有一面書牆，吸音其實不錯；搬走一半的書之後，錄旁白的回音明顯變大。',
];

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC085_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc085-${name}.png`) });
}

const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const editor = (page: Page): Locator => page.locator('.tab-pane:not([hidden]) main.editor');
const pane = (page: Page): Locator => page.locator('.tab-pane:not([hidden])');
const side = (page: Page): Locator => pane(page).locator('section.side');
const sideTab = (page: Page, name: string): Locator =>
  side(page).getByRole('tablist', { name: '側邊欄分頁' }).getByRole('tab', { name });
const split = (page: Page): Locator => pane(page).locator('#preview-panel');
const stage = (page: Page): Locator => split(page).locator('.pv-stage');
/** The screen tabs by class: their name changes with the interface language. */
const screens = (page: Page): Locator => split(page).locator('.pv-stage__screens');
/** The screen in front (the others are inert). */
const shown = (page: Page, name: 'publish' | 'feed' | 'body'): Locator =>
  split(page).locator(`.pv-page:not([inert]) [data-screen="${name}"]`);
const aiPanel = (page: Page): Locator => pane(page).getByRole('complementary', { name: 'AI' });
const content = (page: Page): Locator =>
  page.locator('.tab-pane:not([hidden]) .qc-md-editor__content');

/** A box of the visible tab pane, e.g. `rect(page, 'section.side')`. */
function rect(
  page: Page,
  selector: string,
): Promise<{ top: number; bottom: number; left: number; right: number; width: number }> {
  return page.evaluate(
    `(() => { const r = document.querySelector('.tab-pane:not([hidden]) ${selector}').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; })()`,
  );
}

async function width(page: Page): Promise<number> {
  return (await rect(page, 'section.side')).width;
}

async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click();
  }, id);
}

async function setUp(
  desktop: Parameters<Parameters<typeof test>[2]>[0]['desktop'],
  options: { width?: number; long?: boolean } = {},
) {
  const { page, backend, upstream, app } = desktop;
  await page.setViewportSize({ width: options.width ?? 1600, height: 960 });
  await page.emulateMedia({ colorScheme: 'light' });
  const c = backend.client;
  await c.ai.setKey('anthropic', 'fake-anthropic-key');
  await c.ai.consent('anthropic', backend.ai.providerStatus('anthropic').notice.version);
  const relay = await c.ai.setKey(
    'new-api',
    'sk-relay-fake-0123456789',
    'https://relay.invalid/v1',
  );
  await c.ai.consent('new-api', relay.notice.version, relay.notice.credential_id ?? '');
  upstream.modelsReply = { body: { data: [{ id: IMAGE_MODEL }] } };
  const body = options.long === true ? [...PARAS, '字'.repeat(1100)] : PARAS;
  const work = await c.works.create({
    title: TITLE,
    markdown: `# ${TITLE}\n\n${body.join('\n\n')}\n`,
    source: 'mac-app',
  });
  const srcs: string[] = [];
  for (const [i, color] of ['#9E4428', '#3E4A57', '#5E7A8A'].entries()) {
    const asset = await c.assets.upload({
      data: await pngBytes(600, 800, color),
      filename: `p${String(i)}.png`,
    });
    srcs.push((await c.works.attachMedia(work.id, asset.asset.id)).src);
  }
  const fresh = await c.works.get(work.id);
  await c.works.patch(work.id, {
    base_revision: fresh.current_revision_id,
    markdown: `# ${TITLE}\n\n${body[0] ?? ''}\n\n${srcs.map((s) => `![](${s})`).join('\n\n')}\n\n${body.slice(1).join('\n\n')}\n`,
  });
  await page.reload();
  await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
  await page
    .getByRole('region', { name: '作品', exact: true })
    .getByRole('button', { name: /書房改成剪輯室/ })
    .click();
  await expect(content(page)).toContainText('十坪的書房');
  return { page, c, upstream, work, app };
}

test('側邊欄：全高、預覽三畫面、原位編輯、跟隨原稿、AI 標題、縮放、分頁、收合與寬度', async ({
  desktop,
}) => {
  test.setTimeout(150_000);
  const { page, c, upstream, work, app } = await setUp(desktop);

  await test.step('邊欄預設開在「預覽」：520 寬、從視窗頂端到底、分頁列和作品分頁列同高', async () => {
    await expect(split(page)).toBeVisible();
    await expect(sideTab(page, '預覽')).toHaveAttribute('aria-selected', 'true');
    await expect(sideTab(page, '預覽').locator('..').getByRole('tab')).toHaveText([
      '預覽',
      'AI',
      '歷史',
      '素材',
    ]);
    expect(await width(page)).toBeCloseTo(520, -1);
    const bar = await page.evaluate<{ top: number; bottom: number; right: number }>(
      "(() => { const r = document.querySelector('.tabbar').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; })()",
    );
    const s = await rect(page, 'section.side');
    const head = await rect(page, '.side__head');
    const main = await rect(page, 'main.editor');
    expect(s.top).toBeCloseTo(bar.top, 0);
    expect(head.bottom).toBeCloseTo(bar.bottom, 0);
    // The work tabs span only the left column; the editor ends where the sidebar begins.
    expect(bar.right).toBeLessThanOrEqual(s.left + 1);
    expect(main.right).toBeLessThanOrEqual(s.left + 1);
    expect(s.bottom).toBeCloseTo(main.bottom, 0);
    // The editor head no longer has 預覽 or 歷史 buttons.
    await expect(editor(page).getByRole('button', { name: '預覽', exact: true })).toHaveCount(0);
    await expect(editor(page).getByRole('button', { name: '歷史', exact: true })).toHaveCount(0);
    // Zoom sits in the bar right of the screen tabs, above the phone.
    const zoomBox = await rect(page, '.pv-zoom');
    const screensBox = await rect(page, '.pv-stage__screens');
    const phoneBox = await rect(page, '.pv-phone');
    expect(zoomBox.left).toBeGreaterThan(screensBox.right);
    expect(zoomBox.bottom).toBeLessThanOrEqual(phoneBox.top);
    await expect(screens(page).getByRole('tab')).toHaveText(['發布編輯', '刷到時', '正文']);
    await expect(screens(page).getByRole('tab', { name: '刷到時' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(split(page).getByRole('group', { name: '縮放' })).toContainText('適應高度');
    await expect(split(page).getByText('模擬', { exact: true })).toBeVisible();
    // Follow is on by default.
    await expect(split(page).getByRole('button', { name: /跟隨/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The feed card shows the work's title.
    await expect(shown(page, 'feed')).toContainText(TITLE);
    // Only the phone screen scrolls: the stage and the split never do.
    const scrolls = await page.evaluate<number>(
      "(() => { const s = document.querySelector('.tab-pane:not([hidden]) .pv-stage'); return s === null ? -1 : s.scrollHeight - s.clientHeight; })()",
    );
    expect(scrolls).toBeLessThanOrEqual(0);
    await shot(page, 'side-preview-feed');
  });

  await test.step('正文跟隨左邊未儲存的草稿，即時', async () => {
    await screens(page).getByRole('tab', { name: '正文' }).click();
    await expect(shown(page, 'body')).toContainText('改動最多的反而是光');
    await content(page).getByText('吸音其實不錯').click();
    await page.keyboard.press('End');
    await page.keyboard.type('後來補了兩塊吸音板。');
    await expect(shown(page, 'body')).toContainText('後來補了兩塊吸音板。');
    // The caret's paragraph is highlighted (跟隨).
    await expect(shown(page, 'body').locator('.curp')).toContainText('吸音其實不錯');
    await shot(page, '2-body-follow');
  });

  await test.step('發布編輯：標題原位改成自訂，改回跟隨原稿', async () => {
    await screens(page).getByRole('tab', { name: '發布編輯' }).click();
    const publish = shown(page, 'publish');
    const title = publish.getByRole('textbox', { name: '標題' });
    await expect(title).toHaveValue(TITLE);
    await expect(publish.getByText('跟隨原稿', { exact: true })).toBeVisible();
    await title.fill('十坪書房改剪輯室，半年後我後悔了嗎');
    await expect(publish.getByText('自訂', { exact: true })).toBeVisible();
    await expect(publish.getByText('17/20')).toBeVisible();
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).title_source)
      .toBe('override');
    await shot(page, '3-publish-own');
    await publish.getByRole('button', { name: '改回跟隨原稿' }).first().click();
    await expect(title).toHaveValue(TITLE);
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).title_source)
      .toBe('work');
    // The original title was never written.
    expect((await c.works.get(work.id)).title).toBe(TITLE);
  });

  await test.step('話題：新增與移除只改這個平台', async () => {
    const publish = shown(page, 'publish');
    await publish.getByRole('button', { name: '＋ 話題' }).click();
    await publish.getByRole('textbox', { name: '新增話題' }).fill('剪輯室');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).tags)
      .toEqual(['剪輯室']);
    await publish.getByRole('button', { name: '移除話題 剪輯室' }).click();
    await expect.poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).tags).toEqual([]);
    expect((await c.variants.get(work.id, 'douyin')).tags_source).toBe('work');
  });

  await test.step('AI 標題在手機裡的底部面板；點一個即套用，可復原', async () => {
    upstream.script(
      'anthropic',
      ok(
        'anthropic',
        JSON.stringify({
          xiaohongshu: {
            titles: ['書房改剪輯室的 3 個後悔', '書房變剪輯室：先處理光', '剪輯室改造半年心得'],
          },
        }),
      ),
    );
    await shown(page, 'publish').getByRole('button', { name: 'AI 標題' }).click();
    const sheet = split(page).getByRole('dialog', { name: 'AI 標題' });
    await expect(sheet).toContainText('小紅書 · 上限 20 字');
    const list = sheet.getByRole('listbox', { name: '標題候選' });
    await expect(list.getByRole('option')).toHaveCount(3);
    await shot(page, '4-ai-title-sheet');
    await list.getByRole('option', { name: /先處理光/ }).click();
    await expect(sheet).toHaveCount(0);
    const title = shown(page, 'publish').getByRole('textbox', { name: '標題' });
    await expect(title).toHaveValue('書房變剪輯室：先處理光');
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).title)
      .toBe('書房變剪輯室：先處理光');
    // 復原 sits above the phone, never over it.
    expect(
      await page.evaluate<boolean>(
        "(() => { const q = (s) => document.querySelector('.tab-pane:not([hidden]) ' + s); const a = q('.pv-undo').getBoundingClientRect(); const b = q('.pv-phone').getBoundingClientRect(); return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom; })()",
      ),
    ).toBe(true);
    await split(page).getByRole('button', { name: '復原' }).click();
    await expect(title).toHaveValue(TITLE);
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).title_source)
      .toBe('work');
  });

  await test.step('選封面：從圖片選，設為封面只改這個平台', async () => {
    await shown(page, 'publish').getByRole('button', { name: '選封面' }).click();
    const sheet = split(page).getByRole('dialog', { name: '選封面' });
    await expect(sheet).toContainText('3:4');
    await sheet.getByRole('group', { name: '從圖片選' }).getByRole('button').nth(1).click();
    await shot(page, '5-cover-sheet');
    await sheet.getByRole('button', { name: '設為封面' }).click();
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).cover_source)
      .toBe('override');
    expect((await c.variants.get(work.id, 'wechat_mp')).cover_source).toBe('work');
  });

  await test.step('刷到時點標題：回到發布編輯並聚焦標題', async () => {
    await screens(page).getByRole('tab', { name: '刷到時' }).click();
    await shown(page, 'feed').getByRole('button', { name: '編輯標題' }).click();
    await expect(screens(page).getByRole('tab', { name: '發布編輯' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(shown(page, 'publish').getByRole('textbox', { name: '標題' })).toBeFocused();
  });

  await test.step('←／→ 與兩指左右滑切換畫面', async () => {
    await screens(page).getByRole('tab', { name: '發布編輯' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(screens(page).getByRole('tab', { name: '刷到時' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const box = await stage(page).boundingBox();
    if (box === null) throw new Error('no stage');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(120, 0);
    await expect(screens(page).getByRole('tab', { name: '正文' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  await test.step('縮放：選單、⌘＋／⌘0 只在預覽裡有效，記住選擇', async () => {
    const zoom = split(page).getByRole('group', { name: '縮放' });
    await zoom.getByRole('button', { name: /適應高度/ }).click();
    await split(page).getByRole('menuitemradio', { name: '100%' }).click();
    await expect(zoom).toContainText('100%');
    // Taller than the stage: the phone's top rests below the screen tabs, not under them.
    await expect
      .poll(() =>
        page.evaluate<number>(
          "(() => { const q = (s) => document.querySelector('.tab-pane:not([hidden]) ' + s); return Math.round(q('.pv-phone').getBoundingClientRect().top - q('.pv-stage__screens').getBoundingClientRect().bottom); })()",
        ),
      )
      .toBeGreaterThanOrEqual(0);
    await shot(page, 'side-zoom-100');
    // Pointer over the stage: ⌘0 goes back to fit height.
    const box = await stage(page).boundingBox();
    if (box === null) throw new Error('no stage');
    await page.mouse.move(box.x + box.width / 2, box.y + 30);
    await page.keyboard.press('Meta+0');
    await expect(zoom).toContainText('適應高度');
    await page.keyboard.press('Meta+=');
    await expect(zoom).not.toContainText('適應高度');
    const kept = await zoom.textContent();
    // Hiding and showing the sidebar (⌥⌘0) keeps the choice and the screen.
    await page.keyboard.press('Alt+Meta+0');
    await expect(split(page)).toBeHidden();
    await page.keyboard.press('Alt+Meta+0');
    await expect(split(page).getByRole('group', { name: '縮放' })).toHaveText(kept ?? '');
    await expect(screens(page).getByRole('tab', { name: '正文' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Meta+0');
  });

  await test.step('分頁：AI、歷史、素材在同一個邊欄，切回預覽狀態還在；⌘⇧P、⌘⇧I', async () => {
    await sideTab(page, 'AI').click();
    await expect(aiPanel(page)).toBeVisible();
    await expect(split(page)).toBeHidden();
    await shot(page, 'side-ai');
    // ←／→ move along the sidebar tabs.
    await sideTab(page, 'AI').focus();
    await page.keyboard.press('ArrowRight');
    await expect(sideTab(page, '歷史')).toHaveAttribute('aria-selected', 'true');
    await expect(pane(page).locator('#history-panel')).toBeVisible();
    // ⌘⇧P brings 預覽 forward, on the screen it was left on.
    await page.keyboard.press('Meta+Shift+p');
    await expect(split(page)).toBeVisible();
    await expect(screens(page).getByRole('tab', { name: '正文' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // ⌘⇧I: 素材 with the caret in its search; again hides the sidebar.
    await page.keyboard.press('Meta+Shift+i');
    const drawer = pane(page).getByRole('complementary', { name: '素材抽屜' });
    await expect(drawer.getByPlaceholder('搜尋素材')).toBeFocused();
    await page.keyboard.press('Meta+Shift+i');
    await expect(drawer).toBeHidden();
    expect(await width(page)).toBeCloseTo(44, -1);
    // The menu bar has the same three commands.
    const labels = await app.evaluate(({ Menu }) =>
      ['tab-side-toggle', 'tab-side-preview', 'tab-side-assets'].map(
        (id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.label ?? null,
      ),
    );
    expect(labels).toEqual(['顯示或隱藏側邊欄', '預覽', '素材']);
    await clickMenu(app, 'tab-side-toggle');
    await expect(drawer).toBeVisible();
    await clickMenu(app, 'tab-side-preview');
    await expect(split(page)).toBeVisible();
  });

  await test.step('收合成 44px 圖示欄，點圖示展開到該分頁；拖曳寬度 400–760、雙擊 520、拖過頭收合', async () => {
    await side(page).getByRole('button', { name: '收合側邊欄' }).click();
    expect(await width(page)).toBeCloseTo(44, -1);
    const rail = side(page).getByRole('toolbar', { name: '側邊欄分頁' });
    await expect(rail.getByRole('button')).toHaveCount(5);
    await rail.getByRole('button', { name: '歷史' }).hover();
    await shot(page, 'side-collapsed');
    await rail.getByRole('button', { name: '歷史' }).click();
    await expect(sideTab(page, '歷史')).toHaveAttribute('aria-selected', 'true');
    expect(await width(page)).toBeCloseTo(520, -1);
    await sideTab(page, '預覽').click();
    const handle = side(page).getByRole('separator', { name: '調整側邊欄寬度' });
    const box = await handle.boundingBox();
    if (box === null) throw new Error('no handle');
    await page.mouse.move(box.x + 4, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 400, box.y + 200, { steps: 4 });
    await page.mouse.up();
    expect(await width(page)).toBeCloseTo(760, -1);
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    expect(await width(page)).toBeCloseTo(744, -1);
    await handle.dblclick();
    expect(await width(page)).toBeCloseTo(520, -1);
    // Dragging far below the minimum snaps it shut; ⌥⌘0 brings it back at its width.
    const again = await handle.boundingBox();
    if (again === null) throw new Error('no handle');
    await page.mouse.move(again.x + 4, again.y + 200);
    await page.mouse.down();
    await page.mouse.move(again.x + 260, again.y + 200, { steps: 4 });
    await page.mouse.up();
    expect(await width(page)).toBeCloseTo(44, -1);
    await page.keyboard.press('Alt+Meta+0');
    expect(await width(page)).toBeCloseTo(520, -1);
    await expect(split(page)).toBeVisible();
  });
});

test('側邊欄：超出正文上限的橘點、另一處改了標題（409）、窄視窗抽屜、深色與三語', async ({
  desktop,
}) => {
  test.setTimeout(150_000);
  const { page, c, work } = await setUp(desktop, { long: true });

  await test.step('超出上限：平台分頁與邊欄「預覽」橘點、截斷線、在原稿標出第 1000 字', async () => {
    await expect(sideTab(page, '預覽').getByRole('img', { name: '有平台超出上限' })).toBeVisible();
    const tabs = split(page).getByRole('tablist', { name: '平台' });
    await expect(
      tabs.getByRole('tab', { name: /小紅書/ }).getByRole('img', { name: '超出上限' }),
    ).toBeVisible();
    // 公眾號 allows 20 000 characters: no dot.
    await expect(tabs.getByRole('tab', { name: /公眾號/ }).getByRole('img')).toHaveCount(0);
    await screens(page).getByRole('tab', { name: '正文' }).click();
    const cut = shown(page, 'body').locator('.pv-cutline');
    // The limit is formatted for the language (1,000).
    await expect(cut).toContainText(/第 1,?000 字/);
    await cut.scrollIntoViewIfNeeded();
    await shot(page, 'side-over-limit');
    await shown(page, 'body')
      .getByRole('button', { name: /在原稿標出第 1,?000 字/ })
      .click();
    await expect(content(page)).toBeFocused();
    // Collapsed, the rail's 預覽 keeps the dot.
    await page.keyboard.press('Alt+Meta+0');
    const rail = side(page).getByRole('toolbar', { name: '側邊欄分頁' });
    await expect(rail.getByRole('button', { name: '預覽 · 有平台超出上限' })).toBeVisible();
    await expect(rail.locator('.side__dot')).toHaveCount(1);
    await page.keyboard.press('Alt+Meta+0');
  });

  await test.step('409：另一處改了標題，在手機裡選保留我的', async () => {
    await screens(page).getByRole('tab', { name: '發布編輯' }).click();
    const title = shown(page, 'publish').getByRole('textbox', { name: '標題' });
    await title.fill('我的小紅書標題');
    await expect.poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).revision).toBe(1);
    // Another device writes revision 2 while my next title is still waiting to be saved.
    await title.fill('我的小紅書標題 2');
    await c.variants.patch(work.id, 'xiaohongshu', { base_revision: 1, title: '別處的標題' });
    const sheet = split(page).getByRole('dialog', { name: /另一處改了小紅書的標題/ });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('別處的標題');
    await shot(page, '9-conflict');
    await sheet.getByRole('button', { name: '保留我的' }).click();
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).title)
      .toBe('我的小紅書標題 2');
  });

  await test.step('窄視窗：先縮到 400；編輯欄仍不到 560 才是抽屜；去設定再回來不閃、不收；Esc 或點正文收起', async () => {
    // 1280 wide: the sidebar shrinks (never below 400) so the text keeps 560, and stays docked.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(async () => Math.round((await rect(page, 'main.editor')).width)).toBe(560);
    expect(await width(page)).toBeCloseTo(1280 - 232 - 560, -1);
    await expect(split(page)).toBeVisible();
    await expect(side(page).locator('.side__rail')).toHaveCount(0);
    await shot(page, 'side-1280-docked');
    await page.setViewportSize({ width: 1024, height: 768 });
    // Closed at first: the text keeps its room, the rail stays as the way in.
    await expect.poll(() => width(page)).toBeCloseTo(44, -1);
    await expect(split(page)).toBeHidden();
    const before = await rect(page, 'main.editor');
    await page.keyboard.press('Meta+Shift+p');
    await expect(split(page)).toBeVisible();
    const after = await rect(page, 'main.editor');
    expect(after.width).toBeCloseTo(before.width, 0);
    const drawer = await rect(page, '.side__panel');
    expect(drawer.left).toBeLessThan(before.right);
    await expect(split(page).getByRole('button', { name: '跟隨', exact: true })).toBeVisible();
    await shot(page, 'side-narrow-drawer');
    // 設定 hides the editor area (it measures 0): coming back, the drawer is still out a few
    // frames later, not flashed docked and then folded into the rail (QC-085 pre-release).
    await nav(page).getByRole('button', { name: '設定', exact: true }).click();
    await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    await page
      .getByRole('region', { name: '作品', exact: true })
      .getByRole('button', { name: /書房改成剪輯室/ })
      .click();
    await expect(split(page)).toBeVisible();
    const kept = await page.evaluate<boolean>(
      "new Promise((done) => { let n = 0; const tick = () => { n += 1; if (n < 6) { requestAnimationFrame(tick); return; } const p = document.querySelector('.tab-pane:not([hidden]) .side__panel'); done(p !== null && !p.hidden && document.querySelector('.tab-pane:not([hidden]) section.side').classList.contains('side--drawer')); }; requestAnimationFrame(tick); })",
    );
    expect(kept).toBe(true);
    await expect(split(page)).toBeVisible();
    await content(page)
      .getByText('吸音其實不錯')
      .click({ position: { x: 8, y: 8 } });
    await expect(split(page)).toBeHidden();
    await page.keyboard.press('Meta+Shift+p');
    await expect(split(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(split(page)).toBeHidden();
    await page.keyboard.press('Meta+Shift+p');
    await expect(split(page)).toBeVisible();
    await content(page).getByText('吸音其實不錯').click();
    await expect(split(page)).toBeHidden();
    // Wide again: docked and open, as remembered.
    await page.setViewportSize({ width: 1600, height: 960 });
    await expect.poll(() => width(page)).toBeCloseTo(520, -1);
    await expect(split(page)).toBeVisible();
  });

  await test.step('深色與三語', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await screens(page).getByRole('tab', { name: '刷到時' }).click();
    await shot(page, 'side-dark-feed');
    await page.emulateMedia({ colorScheme: 'light' });
    for (const lang of ['zh-Hans', 'en'] as const) {
      await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
      await expect(split(page)).toHaveAttribute(
        'aria-label',
        lang === 'en' ? 'Platform preview' : '平台预览',
      );
      await expect(side(page).locator('.side__tab')).toHaveText(
        lang === 'en' ? ['Preview', 'AI', 'History', 'Assets'] : ['预览', 'AI', '历史', '素材'],
      );
      for (const tab of lang === 'en' ? ['Publish', 'Post'] : ['发布编辑', '正文']) {
        await screens(page).getByRole('tab', { name: tab }).click();
        await shot(page, `side-${lang}-${tab === 'Post' || tab === '正文' ? 'body' : 'publish'}`);
      }
      // Nothing in the phone runs past its screen.
      const overflow = await page.evaluate<string[]>(
        "[...document.querySelectorAll('.tab-pane:not([hidden]) .pv-page:not([inert]) *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && getComputedStyle(el).whiteSpace === 'nowrap').map((el) => el.className).slice(0, 5)",
      );
      expect(overflow).toEqual([]);
    }
    await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
    expect((await c.works.get(work.id)).title).toBe(TITLE);
  });
});
