import type { Translate } from '@qiu-creator/i18n';
import type { MenuItemConstructorOptions } from 'electron';

/**
 * The macOS menu bar (QC-042). Same items and roles as Electron's default
 * menu, with every label from the catalog so the menu follows 設定 → 語言
 * at once (rebuilt on each change). Pure, so it is unit-tested.
 */
export function menuTemplate(
  t: Translate,
  appName: string,
  options: { devTools: boolean },
): MenuItemConstructorOptions[] {
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
      submenu: [{ role: 'close', label: t('main.menuCloseWindow') }],
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
        { role: 'front', label: t('main.menuFront') },
      ],
    },
  ];
}
