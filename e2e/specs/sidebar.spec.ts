import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-041 sidebar v2 (PT-20261119-001 「v2 · 側欄狀態」): groups, resize with
 * limits, collapse to a rail with ⌃⌘S, remembered across reloads, and the
 * service dot with its popover.
 * Set QC041_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC041_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc041-${name}.png`) });
}

async function navWidth(page: Page): Promise<number> {
  const b = await page.getByRole('navigation', { name: '主導航' }).boundingBox();
  if (b === null) throw new Error('sidebar not rendered');
  return Math.round(b.width);
}

/**
 * Drag the resize handle by dx and release it. `limit` is the label the sidebar must show at the
 * end of the drag. It is drawn by React after the last pointer move, so it is waited for, never
 * read once (QC-049).
 */
async function dragHandle(page: Page, dx: number, limit: string): Promise<void> {
  const handle = page.getByRole('separator', { name: '調整側欄寬度' });
  const b = await handle.boundingBox();
  if (b === null) throw new Error('no handle');
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await expect(page.locator('.sb__handle-tip')).toHaveText(limit);
  await page.mouse.up();
}

/** Wait for the sidebar to be `width` px wide: every layout change here is applied after a render. */
async function expectNavWidth(page: Page, width: number): Promise<void> {
  await expect.poll(() => navWidth(page)).toBe(width);
}

test('側欄：分組、調寬上下限、收起圖示列、記住狀態與服務狀態點', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole('navigation', { name: '主導航' });
  await expect(nav.getByRole('button', { name: '全部作品', exact: true })).toBeVisible();

  await test.step('分組與預設寬度', async () => {
    const groups = await nav.getByRole('group').all();
    const names = await Promise.all(groups.map((g) => g.getAttribute('aria-label')));
    // QC-069: the works' scopes (no heading), 項目, 素材, 工具; 回收站 and 設定 in the foot.
    expect(names).toEqual(['作品', '項目', '素材', '工具']);
    // QC-091: Agent 提案 under 未分類 (no badge without pending proposals).
    await expect(nav.getByRole('group', { name: '作品' }).getByRole('button')).toHaveText([
      /^全部作品\d*$/,
      /^未分類\d*$/,
      'Agent 提案',
    ]);
    // No projects yet, so 新建項目.
    await expect(nav.getByRole('group', { name: '項目' }).getByRole('button')).toHaveText([
      '項目',
      '',
      '新建項目',
    ]);
    await expect(nav.getByRole('group', { name: '素材' }).getByRole('button')).toHaveText([
      '素材庫',
      '匯入任務',
    ]);
    // QC-075/QC-076: 「Prompt」 replaced 「平台預覽」, which is now a split in the editor.
    await expect(nav.getByRole('group', { name: '工具' }).getByRole('button')).toHaveText([
      'AI 工作台',
      'Prompt',
    ]);
    await expect(nav.locator('.sb__foot').getByRole('button')).toHaveText(['回收站', '設定']);
    await expect(nav.getByText('發布中心')).toHaveCount(0);
    // 設定 is pinned at the bottom, below the groups.
    const settings = await nav.getByRole('button', { name: '設定', exact: true }).boundingBox();
    const ai = await nav.getByRole('button', { name: 'AI 工作台', exact: true }).boundingBox();
    expect(settings?.y ?? 0).toBeGreaterThan((ai?.y ?? 0) + 300);
    await expectNavWidth(page, 232);
    await shot(page, '01-expanded-light');
  });

  await test.step('拖曳調寬：最小 200、最大 320、雙擊復原、方向鍵', async () => {
    await dragHandle(page, -120, '最小 200');
    await expectNavWidth(page, 200);
    await dragHandle(page, 400, '最大 320');
    await expectNavWidth(page, 320);
    await shot(page, '02-max-320');
    await page.getByRole('separator', { name: '調整側欄寬度' }).dblclick();
    await expectNavWidth(page, 232);
    const handle = page.getByRole('separator', { name: '調整側欄寬度' });
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '248');
    await expectNavWidth(page, 248);
  });

  await test.step('⌃⌘S 收起成 56 圖示列，聚焦時顯示名稱', async () => {
    await page.keyboard.press('Control+Meta+s');
    await expectNavWidth(page, 56);
    await expect(nav.getByRole('button', { name: '展開側欄' })).toBeVisible();
    const library = nav.getByRole('button', { name: '全部作品', exact: true });
    await expect(library).toBeVisible();
    // Keyboard focus shows the tooltip (the rail hides the text label).
    await library.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(library).toHaveAttribute('data-tip', '全部作品');
    // QC-065: the rail's tooltip is one floating element, so a scrolling rail cannot clip it.
    await expect(nav.locator('.sb__railtip')).toHaveText('全部作品');
    await shot(page, '03-rail-tooltip');
  });

  await test.step('重新載入後仍是收起；展開後回到 248', async () => {
    await page.reload();
    await expect(nav.getByRole('button', { name: '全部作品', exact: true })).toBeVisible();
    await expectNavWidth(page, 56);
    await nav.getByRole('button', { name: '展開側欄' }).click();
    await expectNavWidth(page, 248);
    await page.reload();
    await expect(nav.getByRole('button', { name: '全部作品', exact: true })).toBeVisible();
    await expectNavWidth(page, 248);
    await page.getByRole('separator', { name: '調整側欄寬度' }).dblclick();
  });

  await test.step('窄視窗固定為圖示列', async () => {
    await page.setViewportSize({ width: 860, height: 800 });
    await expectNavWidth(page, 56);
    await expect(nav.getByRole('button', { name: '展開側欄' })).toBeDisabled();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectNavWidth(page, 232);
  });

  await test.step('服務狀態點：正常為綠，聚焦顯示詳情', async () => {
    const dot = nav.getByRole('button', { name: '一切正常' });
    await expect(dot).toBeVisible();
    await dot.focus();
    const pop = page.getByRole('tooltip');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('本機服務');
    await expect(pop).toContainText('已連線');
    await expect(pop).toContainText('Agent API');
    await expect(pop).toContainText('可用');
    await expect(pop).toContainText('版本');
    await shot(page, '04-service-popover');
  });

  await test.step('深色', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.mouse.move(800, 400);
    await page.locator('body').click({ position: { x: 800, y: 400 } });
    await shot(page, '05-expanded-dark');
    await page.keyboard.press('Control+Meta+s');
    await nav.getByRole('button', { name: '素材庫', exact: true }).hover();
    // The tooltip floats beside the rail (QC-065: the rail scrolls, without a visible scrollbar).
    await expect(nav.locator('.sb__railtip')).toHaveText('素材庫');
    const tip = await nav.locator('.sb__railtip').boundingBox();
    expect(tip?.x ?? 0).toBeGreaterThan(56);
    await shot(page, '06-rail-dark');
    await page.keyboard.press('Control+Meta+s');
  });

  await test.step('服務停止：紅點與原因', async () => {
    await backend.close();
    const dot = nav.locator('.sb__dot');
    await expect(nav.locator('.sb__svc--bad')).toBeVisible({ timeout: 15_000 });
    await expect(dot).toHaveAttribute('aria-label', '本機服務未回應', { timeout: 15_000 });
    await dot.focus();
    await expect(page.getByRole('tooltip')).toContainText('已中斷');
    await expect(page.getByRole('tooltip')).toContainText('無法使用');
    await expect(page.getByRole('tooltip').getByRole('button', { name: '重新檢查' })).toBeVisible();
    await shot(page, '07-service-down-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, '08-service-down-light');
  });
});
