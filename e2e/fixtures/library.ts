import { expect, type Locator, type Page } from '@playwright/test';

/*
 * 作品庫 helpers since QC-069 (PT-20261122-001): type and status live in the
 * 篩選 popover, and 回收站 is a row at the foot of the sidebar.
 */

type Group = '類型' | '狀態';

/** The 篩選 button in the page header. */
export const filterButton = (page: Page): Locator => page.locator('main .fmenu__btn');

/** An option in the open 篩選 popover (its text ends with its count). */
export const filterOption = (page: Page, group: Group, name: RegExp | string): Locator =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name });

async function openFilter(page: Page): Promise<void> {
  if ((await page.getByRole('dialog', { name: '篩選' }).count()) === 0)
    await filterButton(page).click();
  await expect(page.getByRole('dialog', { name: '篩選' })).toBeVisible();
}

/** Pick a type or status in 篩選 and close it again. */
export async function chooseFilter(page: Page, group: Group, name: RegExp | string): Promise<void> {
  await openFilter(page);
  await filterOption(page, group, name).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '篩選' })).toHaveCount(0);
}

/** The count beside an option, as the popover shows it (opens 篩選, leaves it open). */
export async function filterCount(
  page: Page,
  group: Group,
  name: RegExp | string,
): Promise<string> {
  await openFilter(page);
  return (await filterOption(page, group, name).locator('.fmenu__n').textContent()) ?? '';
}

/** 回收站 at the foot of the sidebar; its text ends with how many works it holds. */
export const trashRow = (page: Page): Locator =>
  page
    .getByRole('navigation', { name: '主導航' })
    .locator('.sb__foot')
    .getByRole('button', { name: '回收站' });
