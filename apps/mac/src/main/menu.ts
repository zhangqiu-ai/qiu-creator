import type { Translate } from '@qiu-creator/i18n';
import type { MenuItemConstructorOptions } from 'electron';
import type { TabCommand } from '../shared/bridge.js';

/**
 * The macOS menu bar (QC-042). Same items and roles as Electron's default
 * menu, with every label from the catalog so the menu follows 設定 → 語言
 * at once (rebuilt on each change). Pure, so it is unit-tested.
 */
export function menuTemplate(
  t: Translate,
  appName: string,
  options: { devTools: boolean; onTabCommand: (command: TabCommand) => void },
): MenuItemConstructorOptions[] {
  /** Editor tab items (QC-047). Each has an id so tests can find and click it. */
  const tab = (
    command: TabCommand,
    label: string,
    accelerator: string,
  ): MenuItemConstructorOptions => ({
    id: `tab-${command}`,
    label,
    accelerator,
    click: () => {
      options.onTabCommand(command);
    },
  });
  const jumps: MenuItemConstructorOptions[] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    tab(
      `jump-${n as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`,
      t('main.menuTabN', { n }),
      `CommandOrControl+${String(n)}`,
    ),
  );
  jumps.push(tab('jump-9', t('main.menuTabLast'), 'CommandOrControl+9'));
  const view: MenuItemConstructorOptions[] = [
    { role: 'reload', label: t('main.menuReload') },
    { role: 'forceReload', label: t('main.menuForceReload') },
  ];
  if (options.devTools) view.push({ role: 'toggleDevTools', label: t('main.menuDevTools') });
  view.push(
    { type: 'separator' },
    { role: 'resetZoom', label: t('main.menuActualSize') },
    { role: 'zoomIn', label: t('main.menuZoomIn') },
    { role: 'zoomOut', label: t('main.menuZoomOut') },
    { type: 'separator' },
    { role: 'togglefullscreen', label: t('main.menuFullScreen') },
  );
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: t('main.menuAbout', { app: appName }) },
        { type: 'separator' },
        tab('settings', t('main.menuSettings'), 'CommandOrControl+,'),
        { type: 'separator' },
        { role: 'services', label: t('main.menuServices') },
        { type: 'separator' },
        { role: 'hide', label: t('main.menuHide', { app: appName }) },
        { role: 'hideOthers', label: t('main.menuHideOthers') },
        { role: 'unhide', label: t('main.menuShowAll') },
        { type: 'separator' },
        { role: 'quit', label: t('main.menuQuit', { app: appName }) },
      ],
    },
    {
      label: t('main.menuFile'),
      submenu: [
        tab('close', t('main.menuCloseTab'), 'CommandOrControl+W'),
        {
          role: 'close',
          label: t('main.menuCloseWindow'),
          accelerator: 'CommandOrControl+Shift+W',
        },
      ],
    },
    {
      label: t('main.menuEdit'),
      submenu: [
        { role: 'undo', label: t('main.menuUndo') },
        { role: 'redo', label: t('main.menuRedo') },
        { type: 'separator' },
        { role: 'cut', label: t('main.menuCut') },
        { role: 'copy', label: t('main.menuCopy') },
        { role: 'paste', label: t('main.menuPaste') },
        { role: 'pasteAndMatchStyle', label: t('main.menuPasteMatchStyle') },
        { role: 'delete', label: t('main.menuDelete') },
        { role: 'selectAll', label: t('main.menuSelectAll') },
      ],
    },
    { label: t('main.menuView'), submenu: view },
    {
      label: t('main.menuWindow'),
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: t('main.menuMinimize') },
        { role: 'zoom', label: t('main.menuZoom') },
        { type: 'separator' },
        tab('previous', t('main.menuPreviousTab'), 'CommandOrControl+Shift+['),
        tab('next', t('main.menuNextTab'), 'CommandOrControl+Shift+]'),
        { label: t('main.menuGoToTab'), submenu: jumps },
        { type: 'separator' },
        { role: 'front', label: t('main.menuFront') },
      ],
    },
  ];
}
