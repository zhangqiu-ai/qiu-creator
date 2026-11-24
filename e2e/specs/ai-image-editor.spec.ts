import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { ok } from '../../services/mac-server/test/fake-ai.js';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';
import { showSideTab } from '../fixtures/side.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-070 文章編輯的 AI 圖片／封面與選取浮動工具列 (PT-20261122-002), against
 * the local fake relay (no request leaves the machine):
 * - a selection brings up the toolbar after a pause, without taking focus;
 *   ⌘J enters it, ←→ move, esc closes it and keeps the selection;
 * - 潤色 shows the candidate in place as a diff; ⌘↩ keeps it as a new version,
 *   esc discards it and the text stays;
 * - 配圖 opens a placeholder after the paragraph (the text below gives way),
 *   the image settles in with its variants and caption, 保留 writes it into
 *   the work; a failure stays in the placeholder with 重試／移除;
 * - an unknown cost asks once per model; the 圖片 tab makes a cover;
 * - source mode keeps the toolbar beside the line and the result in the panel;
 * - closing the work with a candidate not kept asks first.
 * QC070_SHOTS=<dir> saves screenshots.
 */

const IMAGE_MODEL = 'gpt-image-1';
const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const MD = [
  '# 京都散步',
  '',
  '第一段寫紅葉與寺廟，清晨的光很好。',
  '',
  '第二段寫竹林小徑與人潮。',
  '',
  '第三段寫晚上的鴨川。',
  '',
].join('\n');

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC070_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc070-${name}.png`) });
}

const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const content = (page: Page): Locator => page.locator('.qc-md-editor__content');
const toolbar = (page: Page): Locator => page.getByRole('toolbar', { name: 'AI 工具' });
const panel = (page: Page): Locator => page.getByRole('complementary', { name: 'AI' });

/** Select `text` in the visual editor as a person would (then the mouse comes up). */
async function selectInVisual(page: Page, text: string): Promise<void> {
  const ok = await page.evaluate<boolean>(`(() => {
    const root = document.querySelector('.qc-md-editor__content');
    root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    root.focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.textContent.indexOf(${JSON.stringify(text)});
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + ${String(text.length)});
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      window.dispatchEvent(new MouseEvent('mouseup'));
      return true;
    }
    return false;
  })()`);
  expect(ok).toBe(true);
}

async function images(...colors: string[]) {
  const data = await Promise.all(
    colors.map(async (c) => ({ b64_json: (await pngBytes(320, 180, c)).toString('base64') })),
  );
  return { body: { created: 1, data } };
}

async function setUp(
  desktop: Parameters<Parameters<typeof test>[2]>[0]['desktop'],
  models?: string[],
) {
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const c = backend.client;
  // Text rewrites go to Claude; images to the New API relay (both fakes).
  await c.ai.setKey('anthropic', 'fake-anthropic-key');
  await c.ai.consent('anthropic', backend.ai.providerStatus('anthropic').notice.version);
  const relay = await c.ai.setKey(
    'new-api',
    'sk-relay-fake-0123456789',
    'https://relay.invalid/v1',
  );
  await c.ai.consent('new-api', relay.notice.version, relay.notice.credential_id ?? '');
  upstream.modelsReply = {
    body: { data: (models ?? [IMAGE_MODEL, 'gpt-5.5']).map((id) => ({ id })) },
  };
  const work = await c.works.create({ title: '京都散步', markdown: MD, source: 'mac-app' });
  await page.reload();
  await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
  await page
    .getByRole('region', { name: '作品', exact: true })
    .getByRole('button', { name: /京都散步/ })
    .click();
  await expect(content(page)).toContainText('第一段寫紅葉');
  // QC-085: the AI panel is a tab of the editor sidebar, which opens on 預覽.
  await showSideTab(page, 'AI');
  return { page, c, upstream, work };
}

test('選取浮動工具列：原位改寫候選、配圖佔位與保留、費用提示、封面、關閉時提示', async ({
  desktop,
}) => {
  test.setTimeout(120_000);
  const { page, c, upstream, work } = await setUp(desktop);

  await test.step('選取後出現工具列，焦點留在文字；⌘J 進入、←→ 移動、esc 收起並保留選取', async () => {
    await selectInVisual(page, '紅葉與寺廟');
    await expect(toolbar(page)).toBeVisible();
    await expect(toolbar(page).locator('.ftb__btn')).toHaveText([
      '潤色',
      '擴寫',
      '縮寫',
      '語氣',
      '配圖',
      'Prompt',
    ]);
    // QC-075: the output language and the model switch at the end of the row.
    await expect(toolbar(page).getByRole('button', { name: '輸出語言' })).toBeVisible();
    await expect(toolbar(page).getByRole('button', { name: '模型' })).toBeVisible();
    // It did not take focus: typing would still go into the text.
    expect(await page.evaluate<boolean>("document.activeElement?.closest('.ftb') == null")).toBe(
      true,
    );
    await shot(page, '1-toolbar');
    await page.keyboard.press('Meta+j');
    await expect(toolbar(page).getByRole('button', { name: '潤色' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(toolbar(page).getByRole('button', { name: '擴寫' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(toolbar(page)).toHaveCount(0);
    expect(await page.evaluate<string>('getSelection().toString()')).toBe('紅葉與寺廟');
  });

  await test.step('潤色：候選在原位以 diff 出現；⌘↩ 保留成新版本', async () => {
    upstream.script('anthropic', {
      ...ok('anthropic', '第一段寫楓紅與古寺，清晨的光線很柔和。'),
      delayMs: 600,
    });
    await selectInVisual(page, '紅葉與寺廟');
    await toolbar(page).getByRole('button', { name: '潤色' }).click();
    await expect(page.locator('.inline-ai__lock')).toBeVisible();
    // QC-075: the pill says the action, the language and the model it was sent with.
    await expect(page.locator('.gen-pill')).toContainText(/潤色 · 繁中 · Claude · .+…/);
    await shot(page, '2-text-generating');
    const diff = page.locator('.inline-ai__diff');
    await expect(diff).toBeVisible();
    await expect(diff.locator('ins')).not.toHaveCount(0);
    await expect(page.locator('.editor__unkept')).toHaveText('有候選未保留');
    await shot(page, '3-text-candidate');
    await content(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Meta+Enter');
    await expect(content(page)).toContainText('楓紅與古寺');
    await expect(page.locator('.inline-ai__diff')).toHaveCount(0);
    await expect
      .poll(async () => (await c.works.get(work.id)).markdown)
      .toContain('第一段寫楓紅與古寺');
  });

  await test.step('擴寫後 esc 捨棄：原文不變', async () => {
    upstream.script('anthropic', ok('anthropic', '第二段寫竹林小徑、清晨的霧與漸多的人潮。'));
    await selectInVisual(page, '竹林小徑');
    await toolbar(page).getByRole('button', { name: '擴寫' }).click();
    await expect(page.locator('.inline-ai__diff')).toBeVisible();
    await content(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await expect(page.locator('.inline-ai__diff')).toHaveCount(0);
    await expect(content(page)).toContainText('第二段寫竹林小徑與人潮。');
  });

  await test.step('配圖：費用無法預估先問一次；佔位在段落後、下文讓位；圖片落位後保留寫入作品', async () => {
    upstream.imageReplies.push({ ...(await images('#9E4428', '#2F4FCF')), delayMs: 800 });
    const third = content(page).getByText('第三段寫晚上的鴨川。');
    const before = (await third.boundingBox())?.y ?? 0;
    await selectInVisual(page, '竹林小徑');
    await toolbar(page).getByRole('button', { name: '配圖' }).click();
    const ask = page.getByRole('dialog', { name: '這次生成的費用無法預估' });
    await expect(ask).toContainText(IMAGE_MODEL);
    await ask.getByLabel('這個模型不再提示').check();
    await shot(page, '4-cost-unknown');
    await ask.getByRole('button', { name: '仍要生成' }).click();
    const slot = page.locator('.imgslot');
    await expect(slot).toHaveAttribute('role', 'status');
    await expect(slot).toContainText('生成圖片中');
    // The text below gives way to the placeholder.
    await expect
      .poll(async () => (await third.boundingBox())?.y ?? 0)
      .toBeGreaterThan(before + 100);
    await shot(page, '5-image-generating');
    await expect(slot.locator('img')).toBeVisible();
    await expect(slot.getByRole('button', { name: '第 2 張' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '圖說' })).toHaveValue(
      '第二段寫竹林小徑與人潮。',
    );
    await shot(page, '6-image-candidate');
    await page.getByRole('textbox', { name: '圖說' }).fill('清晨的竹林');
    await page.locator('.imgslot-wrap').getByRole('button', { name: '保留' }).click();
    await expect(page.locator('.imgslot')).toHaveCount(0);
    await expect
      .poll(async () => (await c.works.get(work.id)).markdown)
      .toMatch(/第二段寫竹林小徑與人潮。\n\n!\[清晨的竹林\]\(assets\/[^)]+\)\n\n第三段/);
    await expect(content(page).locator('img')).toBeVisible();
    // The model's request was what the toolbar sent: the selected text, two images.
    expect(upstream.imageRequests[0]).toMatchObject({ model: IMAGE_MODEL, n: 2 });
  });

  await test.step('配圖失敗：錯誤留在佔位框內，移除後版面收回、原文不動', async () => {
    upstream.imageReplies.push({ status: 500, body: { error: { message: 'relay down' } } });
    await selectInVisual(page, '晚上的鴨川');
    await toolbar(page).getByRole('button', { name: '配圖' }).click();
    // Acknowledged for this model: no question this time.
    const failed = page.locator('.imgslot__err');
    await expect(failed).toContainText('生成失敗');
    await shot(page, '7-image-failed');
    await failed.getByRole('button', { name: '移除' }).click();
    await expect(page.locator('.imgslot')).toHaveCount(0);
    await expect(content(page)).toContainText('第三段寫晚上的鴨川。');
  });

  await test.step('減少動態效果：骨架靜止，只有淡入淡出；取消後版面收回', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    upstream.imageReplies.push({ ...(await images('#9E4428')), delayMs: 3000 });
    await selectInVisual(page, '晚上的鴨川');
    await toolbar(page).getByRole('button', { name: '配圖' }).click();
    await expect(page.locator('.imgslot__sk')).toBeVisible();
    expect(
      await page.evaluate<string>(
        "getComputedStyle(document.querySelector('.imgslot__sk')).animationName",
      ),
    ).toBe('none');
    await shot(page, '7b-reduced-motion');
    await page.locator('.imgslot').getByRole('button', { name: '取消' }).click();
    await expect(page.locator('.imgslot')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  // QC-076: the 圖片 tab is illustrations only; platform covers are generated in 預覽.
  await test.step('圖片分頁只做插圖；生成後設為作品封面，文章頂部出現封面', async () => {
    upstream.imageReplies.push(await images('#3E5A3A'));
    await panel(page).getByRole('tab', { name: '圖片' }).click();
    await expect(panel(page).getByRole('radio', { name: '封面', exact: true })).toHaveCount(0);
    await expect(
      panel(page).getByText('只做插圖；標題與封面在「預覽」裡依平台生成。'),
    ).toBeVisible();
    await panel(page).getByRole('textbox', { name: '提示詞' }).fill('書房的暖光');
    await panel(page).getByRole('radio', { name: '1', exact: true }).click();
    await expect(panel(page).getByText('費用無法預估')).toBeVisible();
    await shot(page, '8-panel-cover');
    await panel(page)
      .getByRole('button', { name: /生成 1 張/ })
      .click();
    const cell = panel(page).locator('.ai-img__cell').first();
    await expect(cell.locator('img')).toBeVisible();
    await cell.hover();
    await cell.getByRole('button', { name: '設為封面' }).click();
    await expect(page.locator('.cover-strip img')).toBeVisible();
    // The image kept earlier still shows after the new version is loaded.
    await expect
      .poll(() =>
        page.evaluate<number>(
          "(() => { const i = document.querySelector('.qc-md-editor__content img'); return i ? i.naturalWidth : 0; })()",
        ),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await c.works.get(work.id)).markdown)
      .toMatch(/^---\n[\s\S]*cover: assets\//);
    await shot(page, '9-cover-set');
  });

  await test.step('有候選未保留時關閉作品：先問；取消留著，捨棄並關閉才關', async () => {
    upstream.imageReplies.push(await images('#5E4130'));
    await panel(page).getByRole('textbox', { name: '提示詞' }).fill('鴨川夜景');
    await panel(page)
      .getByRole('button', { name: /生成 1 張/ })
      .click();
    await expect(panel(page).locator('.ai-img__cell img').first()).toBeVisible();
    await expect(page.locator('.editor__unkept')).toBeVisible();
    await page.keyboard.press('Meta+w');
    const ask = page.getByRole('dialog', { name: /還有 AI 候選沒有保留/ });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: '取消' }).click();
    await expect(content(page)).toBeVisible();
    await page.keyboard.press('Meta+w');
    await page.getByRole('dialog').getByRole('button', { name: '捨棄並關閉' }).click();
    await expect(page.getByRole('main', { name: '作品庫' })).toBeVisible();
  });
});

test('沒有圖片模型、Prompt 直接輸入指令、原始碼模式、減少動態效果、三語與深色', async ({
  desktop,
}) => {
  test.setTimeout(120_000);
  const { page, upstream } = await setUp(desktop, ['gpt-5.5']);

  await test.step('沒有圖片模型：配圖停用並說明；圖片分頁寫出原因與「前往 AI 服務」', async () => {
    await selectInVisual(page, '竹林小徑');
    await expect(toolbar(page)).toBeVisible();
    const image = toolbar(page).getByRole('button', { name: '配圖' });
    await expect(image).toBeDisabled();
    await expect(image).toHaveAttribute('title', '沒有可用的圖片模型');
    await panel(page).getByRole('tab', { name: '圖片' }).click();
    await expect(panel(page).getByRole('alert')).toContainText('沒有可用的圖片模型');
    await expect(panel(page).getByRole('button', { name: '前往 AI 服務' })).toBeVisible();
    await shot(page, '10-no-model');
    await panel(page).getByRole('tab', { name: '改寫' }).click();
  });

  await test.step('Prompt：搜尋框也收直接輸入的指令，↩ 送出，結果在原位', async () => {
    upstream.script('anthropic', ok('anthropic', '第二段寫竹林小徑，人潮洶湧。'));
    await selectInVisual(page, '竹林小徑');
    await toolbar(page).getByRole('button', { name: 'Prompt' }).click();
    const field = toolbar(page).getByRole('combobox', { name: '搜尋 prompt，或直接輸入指令' });
    await expect(field).toBeFocused();
    await shot(page, '11-more');
    await field.fill('寫得更緊湊');
    await field.press('Enter');
    await expect(page.locator('.inline-ai__diff')).toBeVisible();
    const sent = JSON.stringify(desktop.upstream.for('anthropic').at(-1)?.body ?? {});
    expect(sent).toContain('寫得更緊湊');
    await content(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await expect(page.locator('.inline-ai__diff')).toHaveCount(0);
  });

  await test.step('原始碼模式：工具列直立在選取行左側、不蓋住文字；結果在右側面板', async () => {
    upstream.script('anthropic', ok('anthropic', '第三段寫夜晚的鴨川。'));
    await page.getByRole('button', { name: '原始碼', exact: true }).click();
    const source = page.locator('.qc-md-editor__source');
    await expect(source).toBeVisible();
    await page.evaluate(`(() => {
      const t = document.querySelector('.qc-md-editor__source');
      t.focus();
      const i = t.value.indexOf('晚上的鴨川');
      t.setSelectionRange(i, i + 5);
      t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    })()`);
    await expect(toolbar(page)).toHaveAttribute('aria-orientation', 'vertical');
    const bar = await toolbar(page).boundingBox();
    const area = await source.boundingBox();
    const padding = await page.evaluate<number>(
      "parseFloat(getComputedStyle(document.querySelector('.qc-md-editor__source')).paddingLeft)",
    );
    expect(bar !== null && area !== null && bar.x + bar.width <= area.x + padding).toBe(true);
    await shot(page, '12-source-toolbar');
    await toolbar(page).getByRole('button', { name: '潤色' }).click();
    // No diff over the Markdown: the candidate is in the panel.
    await expect(panel(page).getByRole('tab', { name: '改寫' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(panel(page).locator('.ai__hunk').first()).toBeVisible();
    await expect(page.locator('.inline-ai__diff')).toHaveCount(0);
    await shot(page, '13-source-panel');
    await panel(page).getByRole('button', { name: /捨棄/ }).click();
    await page.getByRole('button', { name: '視覺', exact: true }).click();
  });

  await test.step('English、简体與深色：工具列與圖片分頁', async () => {
    for (const [lang, names] of [
      ['en', { polish: 'Polish', images: 'Images' }],
      ['zh-Hans', { polish: '润色', images: '图片' }],
    ] as const) {
      await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
      await selectInVisual(page, '竹林小徑');
      await expect(
        page.getByRole('toolbar').getByRole('button', { name: names.polish }),
      ).toBeVisible();
      await shot(page, `14-toolbar-${lang}`);
      await page.getByRole('tab', { name: names.images }).click();
      await shot(page, `15-panel-${lang}`);
    }
    await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
    await page.emulateMedia({ colorScheme: 'dark' });
    await selectInVisual(page, '竹林小徑');
    await expect(toolbar(page)).toBeVisible();
    await shot(page, '16-dark');
  });
});

test('動效錄影（正常速度）：工具列、文字候選交叉淡化、配圖骨架與圖片落位、保留', async ({
  desktop,
}) => {
  test.skip(!motionOn, 'records motion only with QC_E2E_MOTION=on');
  test.setTimeout(120_000);
  const { page, upstream } = await setUp(desktop);
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop = videoDir === '' ? null : await startScreencast(page, videoDir, 'qc070-ai-editor');

  upstream.script('anthropic', {
    ...ok('anthropic', '第一段寫楓紅與古寺，清晨的光線很柔和。'),
    delayMs: 1500,
  });
  await selectInVisual(page, '紅葉與寺廟');
  await expect(toolbar(page)).toBeVisible();
  await page.waitForTimeout(500); // pacing for the recording
  await toolbar(page).getByRole('button', { name: '潤色' }).click();
  await expect(page.locator('.inline-ai__diff')).toBeVisible();
  await page.waitForTimeout(900);
  await content(page).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Meta+Enter');
  await expect(content(page)).toContainText('楓紅與古寺');

  upstream.imageReplies.push({ ...(await images('#9E4428', '#2F4FCF')), delayMs: 2500 });
  await selectInVisual(page, '竹林小徑');
  await toolbar(page).getByRole('button', { name: '配圖' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '仍要生成' }).click();
  await expect(page.locator('.imgslot img')).toBeVisible();
  await page.waitForTimeout(700);
  await page.locator('.imgslot').getByRole('button', { name: '第 2 張' }).click();
  await page.waitForTimeout(500);
  await page.locator('.imgslot-wrap').getByRole('button', { name: '保留' }).click();
  await expect(content(page).locator('img')).toBeVisible();
  await page.waitForTimeout(800);
  if (stop !== null) test.info().annotations.push({ type: 'video', description: await stop() });
});
