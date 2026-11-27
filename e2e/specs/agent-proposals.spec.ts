import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { createClient, type CreatorHubClient } from '../../packages/api-client/src/index.js';
import { test } from '../fixtures/desktop.js';
import { editorSide, showSideTab } from '../fixtures/side.js';

/*
 * QC-091 (PT-20261124-001): what agents do through MCP, as the user sees it.
 * - Agent 提案 under 未分類 with a pending badge; the inbox lists proposals,
 *   shows the agent's note as a quote, and each change with a checkbox;
 *   partial 採用 makes a version marked “採用 X 的提案”; an overlap with
 *   later edits turns 採用 off until the three-way comparison is used;
 *   捨棄 moves it to 已處理.
 * - The editor sidebar's 提案 tab (only while there are pending ones), with
 *   the changes highlighted in the text.
 * - 設定 › Agent 與 MCP: scopes, 允許直接修改正文 behind a confirmation
 *   (「我了解」, red button, focus on 取消), project limit, and activity where
 *   a direct edit can be undone; 匯入任務 keeps a link.
 * The agents are real tokens on the test service; nothing leaves the machine.
 * 複製 MCP 設定 is not clicked here: it would write the real system clipboard; the
 * config it copies is unit-tested (agents-ui.test.ts).
 * QC091_SHOTS=<dir> saves screenshots.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC091_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc091-${name}.png`) });
}

const KYOTO = [
  '# 京都紅葉季七日慢遊路線',
  '',
  '第四天從京都車站搭 JR 奈良線到稻荷站，大約走 5 分鐘。',
  '',
  '伏見稻荷大社免門票。',
  '',
  '嵐山的竹林在往裡走，就是常寂光寺。',
  '',
].join('\n');
const STUDIO = [
  '# 我把書房改成剪輯室：半年後的取捨',
  '',
  '今年三月，我把十坪的書房改成剪輯室。',
  '',
  '如果重來一次，我會先處理光和聲音，再買設備。',
  '',
].join('\n');

const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const inboxRow = (page: Page): Locator => nav(page).getByRole('button', { name: /^Agent 提案/ });
const list = (page: Page): Locator => page.getByRole('region', { name: '提案' });
const content = (page: Page): Locator =>
  page.locator('.tab-pane:not([hidden]) .qc-md-editor__content');

function agentClient(baseUrl: string, secret: string): CreatorHubClient {
  return createClient({ baseUrl, token: secret });
}

test('Agent 提案：收件匣、部分採用、重疊不能採用與三方對照、捨棄、編輯頁提案分頁', async ({
  desktop,
}) => {
  test.setTimeout(120_000);
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  const claude = backend.tokens.create({ name: 'Claude Code', scopes: ['read', 'propose'] });
  const codex = backend.tokens.create({ name: 'Codex', scopes: ['read', 'propose'] });
  const cc = agentClient(backend.baseUrl, claude.secret);
  const cx = agentClient(backend.baseUrl, codex.secret);

  const kyoto = await c.works.create({ title: '京都紅葉季七日慢遊路線', markdown: KYOTO });
  const studio = await c.works.create({
    title: '我把書房改成剪輯室：半年後的取捨',
    markdown: STUDIO,
  });
  await cc.proposals.create(
    kyoto.id,
    {
      base_revision: kyoto.current_revision_id,
      markdown: KYOTO.replace('大約走 5 分鐘。', '約 5 分鐘、150 日圓；出站就是千本鳥居的入口。')
        .replace('伏見稻荷大社免門票。', '伏見稻荷大社免門票，清水寺門票 500 日圓。')
        .replace('竹林在往裡走', '竹林再往裡走'),
      note: '補上第 4 天的交通方式與門票價格，修正一個錯字。',
    },
    { idempotencyKey: 'qc091-kyoto-first' },
  );
  await cx.proposals.create(
    studio.id,
    {
      base_revision: studio.current_revision_id,
      markdown: STUDIO.replace(
        '再買設備。',
        '再買設備。你的工作室最先改的是什麼？歡迎留言告訴我。',
      ),
      note: '把結尾改成提問，增加互動。',
    },
    { idempotencyKey: 'qc091-studio-first' },
  );
  // The user changes the same ending afterwards: Codex's proposal now overlaps.
  await c.works.patch(studio.id, {
    base_revision: studio.current_revision_id,
    markdown: STUDIO.replace('再買設備。', '最後才買設備。'),
  });
  await page.reload();

  await test.step('側欄「Agent 提案」在未分類下方，顯示待處理數量', async () => {
    await expect(inboxRow(page)).toHaveAccessibleName('Agent 提案 2 個待處理');
    await inboxRow(page).click();
    await expect(page.getByRole('heading', { name: 'Agent 提案', level: 1 })).toBeVisible();
    await expect(list(page).locator('.pr-row')).toHaveCount(2);
    await expect(list(page).getByText('Agent 只能提案，採用前不會改動原稿。')).toBeVisible();
  });

  await test.step('提案詳情：Agent 說明是引號框、只作參考；逐處勾選，部分採用', async () => {
    await list(page)
      .getByRole('button', { name: /京都紅葉季/ })
      .click();
    const note = page.locator('.pr-note');
    await expect(note).toContainText('「補上第 4 天的交通方式與門票價格，修正一個錯字。」');
    await expect(note).toContainText('這是 Agent 寫的文字，只作參考。');
    const changes = page.getByRole('list', { name: '變更' });
    await expect(changes.getByRole('listitem')).toHaveCount(3);
    await shot(page, 'inbox');
    await changes.getByRole('checkbox', { name: '採用第 3 處' }).uncheck();
    await page.getByRole('button', { name: '採用選取的 2 / 3 處' }).click();
    const after = await c.works.get(kyoto.id);
    // QC-103/QC-111: the lines the agent changed are in the default script
    // (zh-Hans); every line it did not change is the user's, word for word.
    expect(after.markdown).toContain('约 5 分钟、150 日圆');
    expect(after.markdown).toContain('清水寺门票 500 日圆');
    expect(after.markdown).toContain('# 京都紅葉季七日慢遊路線\n');
    // The change left out stays as it was.
    expect(after.markdown).toContain('竹林在往裡走');
    const revs = await c.works.revisions(kyoto.id);
    expect(revs.items[0]?.agent).toMatchObject({ name: 'Claude Code', via: 'proposal' });
    await expect(inboxRow(page)).toHaveAccessibleName('Agent 提案 1 個待處理');
    // The proposal left the list: no notice (QC-115).
    await expect(page.locator('[data-toast]').filter({ hasText: '已採用' })).toHaveCount(0);
  });

  await test.step('和之後的修改重疊：紅色提示、不能採用；三方對照；捨棄後到已處理', async () => {
    await list(page)
      .getByRole('button', { name: /書房改成剪輯室/ })
      .click();
    const alert = page.locator('.pr-banner--bad');
    await expect(alert).toContainText('和你之後的修改重疊');
    await expect(page.getByRole('button', { name: '處理重疊後才能採用' })).toHaveCount(0);
    // The overlapping change is not picked, so nothing can be accepted.
    await expect(page.locator('.pr-view__accept')).toBeDisabled();
    await page.getByRole('checkbox', { name: '採用第 1 處' }).check();
    await expect(page.getByRole('button', { name: '處理重疊後才能採用' })).toBeDisabled();
    await shot(page, 'inbox-conflict');
    await alert.getByRole('button', { name: '看三方對照' }).click();
    const dialog = page.getByRole('dialog', { name: /三方對照/ });
    await expect(dialog.getByText('你現在的版本', { exact: false })).toBeVisible();
    await expect(dialog).toContainText('最後才買設備。');
    await expect(dialog).toContainText('欢迎留言告诉我。');
    await shot(page, 'three-way');
    await dialog.getByRole('button', { name: '不採用重疊的 1 處' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: '採用第 1 處' })).not.toBeChecked();
    await page.getByRole('button', { name: '捨棄' }).click();
    await expect(list(page).getByText('沒有待處理的提案')).toBeVisible();
    await expect(page.locator('[data-toast]').filter({ hasText: '已捨棄提案' })).toHaveCount(0);
    await expect(inboxRow(page)).toHaveAccessibleName('Agent 提案');
    await page
      .getByRole('group', { name: '提案狀態' })
      .getByRole('button', { name: '已處理' })
      .click();
    await expect(list(page).locator('.pr-row')).toHaveCount(2);
    await expect(list(page).getByRole('button', { name: /書房改成剪輯室/ })).toContainText(
      '已捨棄',
    );
    // The original was never touched by the discarded proposal.
    expect((await c.works.get(studio.id)).markdown).toContain('最後才買設備。');
  });

  await test.step('編輯頁「提案」分頁：在編輯頁打開、正文高亮變更處、就地採用、歷史標示', async () => {
    const now = await c.works.get(kyoto.id);
    await cc.proposals.create(
      kyoto.id,
      {
        base_revision: now.current_revision_id,
        markdown: now.markdown.replace('竹林在往裡走', '竹林再往裡走'),
        note: '修正錯字。',
      },
      { idempotencyKey: 'qc091-kyoto-second' },
    );
    await page
      .getByRole('group', { name: '提案狀態' })
      .getByRole('button', { name: /待處理/ })
      .click();
    await list(page)
      .getByRole('button', { name: /京都紅葉季/ })
      .click();
    await page.getByRole('button', { name: '在編輯頁打開' }).click();
    await expect(content(page)).toContainText('竹林在往裡走');
    const tab = editorSide(page).getByRole('tab', { name: /^提案/ });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toContainText('1');
    await expect(content(page).locator('[data-proposal-hit]')).toHaveCount(1);
    await expect(content(page).locator('[data-proposal-hit]')).toContainText('竹林在往裡走');
    await shot(page, 'editor-proposal-tab');
    await editorSide(page).getByRole('button', { name: '採用', exact: true }).click();
    // The agent's changed line, in zh-Hans (QC-103/QC-111).
    await expect(content(page)).toContainText('竹林再往里走');
    await expect(content(page)).toContainText('京都紅葉季七日慢遊路線');
    // No pending proposals left: the tab goes away.
    await expect(tab).toHaveCount(0);
    await showSideTab(page, '歷史');
    await expect(page.locator('.tab-pane:not([hidden]) #history-panel')).toContainText(
      '採用 Claude Code 的提案',
    );
  });
});

test('設定 › Agent 與 MCP：範圍、直接修改的確認、限定項目、活動與恢復上一版；匯入任務的連結', async ({
  desktop,
}) => {
  test.setTimeout(120_000);
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  const project = await c.projects.create({ name: '京都旅行' });
  const obsidian = backend.tokens.create({
    name: 'Obsidian 同步',
    scopes: ['read', 'import', 'write'],
  });
  const work = await c.works.create({
    title: '一人食：15 分鐘番茄牛腩飯',
    markdown: '# 一人食\n\n材料：番茄、牛腩。\n',
    project_ids: [project.id],
  });
  await page.reload();

  const detail = page.locator('.ag__detail');
  await test.step('匯入任務頁留一個連結到設定', async () => {
    await nav(page).getByRole('button', { name: '匯入任務', exact: true }).click();
    await page.getByRole('button', { name: '前往設定' }).click();
    await expect(page.getByRole('heading', { name: 'Agent 與 MCP', level: 1 })).toBeFocused();
    await expect(page.locator('.ag-token')).toHaveCount(1);
    await expect(detail.getByRole('heading', { name: 'Obsidian 同步' })).toBeVisible();
  });

  await test.step('範圍逐項勾選，立即儲存', async () => {
    await detail.getByRole('checkbox', { name: /提案修改正文/ }).check();
    await expect
      .poll(async () =>
        [
          ...((await c.tokens.list()).items.find((x) => x.id === obsidian.token.id)?.scopes ?? []),
        ].sort(),
      )
      .toEqual(['import', 'propose', 'read', 'write']);
    await expect(page.locator('.ag-token').first()).toContainText(
      '讀取・匯入・修改資料・提案修改正文',
    );
  });

  await test.step('限定項目：只限這些項目，加入一個', async () => {
    await detail.getByRole('radio', { name: '只限這些項目' }).check();
    await detail.getByRole('combobox', { name: '加入項目' }).selectOption({ label: '京都旅行' });
    await expect
      .poll(
        async () =>
          (await c.tokens.list()).items.find((x) => x.id === obsidian.token.id)?.project_ids,
      )
      .toEqual([project.id]);
    await expect(page.locator('.ag-token').first()).toContainText('限 1 個項目');
  });

  await test.step('允許直接修改正文：確認框要勾我了解，紅色按鈕，焦點在取消', async () => {
    await detail.getByRole('switch', { name: /允許直接修改正文/ }).click();
    const dialog = page.getByRole('dialog', { name: '讓 Obsidian 同步 直接修改正文？' });
    await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
    await expect(dialog).toContainText('只對「京都旅行」有效');
    const allow = dialog.getByRole('button', { name: '允許直接修改' });
    await expect(allow).toBeDisabled();
    await expect(allow).toHaveClass(/btn--danger-solid/);
    await shot(page, 'tokens-direct-confirm');
    await dialog.getByRole('checkbox', { name: '我了解這個 Agent 會直接改寫我的原稿' }).check();
    await allow.click();
    await expect
      .poll(
        async () =>
          (await c.tokens.list()).items.find((x) => x.id === obsidian.token.id)
            ?.allow_direct_body_edit,
      )
      .toBe(true);
    await expect(detail.locator('.ag-direct--on')).toBeVisible();
    await expect(page.locator('.ag-token').first()).toContainText('可直接改正文');
  });

  await test.step('直接修改出現在活動記錄，可以恢復上一版；歷史標明 Agent 直接修改', async () => {
    const agent = agentClient(backend.baseUrl, obsidian.secret);
    const edited = await agent.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: '# 一人食\n\n材料：番茄、牛腩、洋蔥。\n',
    });
    expect((await c.works.revisions(work.id)).items[0]?.agent?.via).toBe('direct');
    // Re-open the token to read its newest activity.
    await page
      .getByRole('navigation', { name: '設定分類' })
      .getByRole('button', { name: '外觀' })
      .click();
    await page
      .getByRole('navigation', { name: '設定分類' })
      .getByRole('button', { name: 'Agent 與 MCP' })
      .click();
    const row = page.locator('.ag-act', { hasText: '直接修改「一人食：15 分鐘番茄牛腩飯」' });
    await expect(row).toBeVisible();
    await shot(page, 'tokens-direct-on');
    await row.getByRole('button', { name: '恢復上一版' }).click();
    await expect(page.locator('[data-toast]').filter({ hasText: '已恢復到上一版' })).toBeVisible();
    const restored = await c.works.get(work.id);
    expect(restored.markdown).toBe('# 一人食\n\n材料：番茄、牛腩。\n');
    expect(restored.current_revision_id).not.toBe(edited.current_revision_id);
  });

  await test.step('關掉直接修改不需確認；三語與深色', async () => {
    await detail.getByRole('switch', { name: /允許直接修改正文/ }).click();
    await expect(detail.locator('.ag-direct--on')).toHaveCount(0);
    await shot(page, 'tokens');
    for (const lang of ['zh-Hans', 'en'] as const) {
      await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
      await expect(page.locator('#set-agents')).toHaveText(
        lang === 'en' ? 'Agents & MCP' : 'Agent 与 MCP',
      );
      await shot(page, `tokens-${lang}`);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'tokens-en-dark');
    await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
    await page.emulateMedia({ colorScheme: 'light' });
  });
});

test('項目設定：描述、規則與試算；Agent 歸入的作品卡標示、保留與復原', async ({ desktop }) => {
  test.setTimeout(120_000);
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  // QC-103/QC-111: agents here create works with Traditional titles, like
  // the user's own data in these screens; with the global 作品文字字體 set
  // to zh-Hant they stay as written (conversion has its own tests).
  await c.settings.setTextScript({ script: 'zh-Hant' });
  const kyoto = await c.projects.create({ name: '京都旅行' });
  await c.works.create({
    title: '京都散步路線',
    markdown: '# 京都散步路線\n\n從京都車站出發，先去錦市場。\n',
    tags: ['京都'],
  });
  await c.works.create({
    title: '一人食：番茄牛腩飯',
    markdown: '# 一人食\n\n材料：番茄、牛腩。\n',
  });
  const agent = backend.tokens.create({ name: 'Claude Code', scopes: ['read', 'import', 'write'] });
  const ac = agentClient(backend.baseUrl, agent.secret);
  await page.reload();

  await test.step('項目選單 › 項目設定…：描述、關鍵字、標籤；試算即時更新，儲存才寫入', async () => {
    await page.locator('[data-project-row]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '項目設定…' }).click();
    const dialog = page.getByRole('dialog', { name: '項目設定 · 京都旅行' });
    await dialog.getByRole('textbox', { name: '描述' }).fill('2026 年秋天京都七日行的所有內容。');
    const keywords = dialog.getByRole('group', { name: '關鍵字' });
    await keywords.getByRole('button', { name: '新增關鍵字' }).click();
    await keywords.getByRole('textbox', { name: '新增關鍵字' }).fill('京都');
    await page.keyboard.press('Enter');
    await keywords.getByRole('textbox', { name: '新增關鍵字' }).fill('錦市場');
    await page.keyboard.press('Enter');
    await keywords.getByRole('textbox', { name: '新增關鍵字' }).fill('京都');
    await page.keyboard.press('Enter');
    await expect(keywords.getByRole('alert')).toHaveText('已經有「京都」了');
    const tags = dialog.getByRole('group', { name: '標籤' });
    await tags.getByRole('button', { name: '新增標籤' }).click();
    await tags.getByRole('textbox', { name: '新增標籤' }).fill('#京都');
    await page.keyboard.press('Enter');
    const domains = dialog.getByRole('group', { name: '來源網域' });
    await domains.getByRole('button', { name: '新增來源網域' }).click();
    await domains
      .getByRole('textbox', { name: '新增來源網域' })
      .fill('https://www.kyoto.travel/en');
    await page.keyboard.press('Enter');
    await expect(domains).toContainText('kyoto.travel');
    // The trial scores the latest works with these (unsaved) rules.
    const trial = dialog.getByRole('region', { name: '試算：最近 20 個作品' });
    const row = trial.locator('.pj-trial__row', { hasText: '京都散步路線' });
    await expect(row).toContainText('會自動歸入');
    await expect(row).toContainText('標題出現「京都」');
    await expect(trial.locator('.pj-trial__row', { hasText: '一人食' })).toContainText(
      '沒有符合的規則',
    );
    // Nothing is saved yet.
    expect((await c.projects.list()).items[0]?.rules?.keywords ?? []).toEqual([]);
    await shot(page, 'project-rules');
    await dialog.getByRole('button', { name: '儲存' }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await c.projects.list()).items.find((p) => p.id === kyoto.id);
    expect(saved?.description).toBe('2026 年秋天京都七日行的所有內容。');
    expect(saved?.rules).toEqual({
      keywords: ['京都', '錦市場'],
      tags: ['京都'],
      folders: [],
      domains: ['kyoto.travel'],
    });
  });

  await test.step('Agent 依規則自動歸入：作品卡藍框加 Agent 圖示，說明浮層；保留改為手動', async () => {
    const made = await ac.works.create(
      {
        title: '京都錦市場吃什麼',
        markdown: '# 京都錦市場吃什麼\n\n京都的錦市場有很多小吃。\n',
        tags: ['京都'],
        auto_assign: true,
      },
      { idempotencyKey: 'qc091-assign-first' },
    );
    expect(made.auto_assignment?.assigned.map((m) => m.project_id)).toEqual([kyoto.id]);
    const card = page.getByRole('region', { name: '作品', exact: true }).locator('.wcard', {
      hasText: '京都錦市場吃什麼',
    });
    const badge = card.getByRole('button', { name: '由 Agent 歸入「京都旅行」，查看說明' });
    await expect(badge).toBeVisible();
    await badge.click();
    const pop = page.getByRole('dialog', { name: '由 Claude Code 歸入「京都旅行」' });
    await expect(pop).toContainText(/自動歸入（分數 0\.\d\d）/);
    await expect(pop).toContainText('標題出現「京都」');
    await shot(page, 'agent-assigned');
    // Opening the explanation did not open the work.
    await expect(page.locator('.tab-pane:not([hidden]) .qc-md-editor__content')).toHaveCount(0);
    await pop.getByRole('button', { name: '保留（改為手動）' }).click();
    await expect(badge).toHaveCount(0);
    // The agent mark left the card: no notice (QC-115).
    await expect(page.locator('[data-toast]').filter({ hasText: '改為手動歸入' })).toHaveCount(0);
    const kept = await c.projects.workMemberships(made.id);
    expect(kept.items[0]?.added_by.kind).toBe('user');
  });

  await test.step('復原歸入：作品離開項目', async () => {
    const made = await ac.works.create(
      {
        title: '京都錦市場第二輪',
        markdown: '# 京都錦市場第二輪\n\n京都錦市場再訪。\n',
        tags: ['京都'],
        auto_assign: true,
      },
      { idempotencyKey: 'qc091-assign-second' },
    );
    const card = page.getByRole('region', { name: '作品', exact: true }).locator('.wcard', {
      hasText: '京都錦市場第二輪',
    });
    await card.getByRole('button', { name: /由 Agent 歸入/ }).click();
    await page
      .getByRole('dialog', { name: /由 Claude Code 歸入/ })
      .getByRole('button', { name: '復原歸入' })
      .click();
    await expect.poll(async () => (await c.works.get(made.id)).project_ids ?? []).toEqual([]);
    await expect(card.getByRole('button', { name: /由 Agent 歸入/ })).toHaveCount(0);
    await expect(page.locator('[data-toast]').filter({ hasText: '移出「京都旅行」' })).toHaveCount(
      0,
    );
  });
});
