import { defineMessages } from '../define.js';

/**
 * The work editor's full-height right sidebar (QC-085, PT-20261123-002):
 * its tabs, collapse rail, resize handle and narrow-window drawer.
 */
export const editorSide = defineMessages({
  'zh-Hant': {
    label: '側邊欄',
    tabs: '側邊欄分頁',
    preview: '預覽',
    ai: 'AI',
    history: '歷史',
    assets: '素材',
    collapse: '收合側邊欄',
    expand: '展開側邊欄',
    resize: '調整側邊欄寬度',
    overLimit: '有平台超出上限',
  },
  'zh-Hans': {
    label: '侧边栏',
    tabs: '侧边栏标签',
    preview: '预览',
    ai: 'AI',
    history: '历史',
    assets: '素材',
    collapse: '收起侧边栏',
    expand: '展开侧边栏',
    resize: '调整侧边栏宽度',
    overLimit: '有平台超出上限',
  },
  en: {
    label: 'Sidebar',
    tabs: 'Sidebar tabs',
    preview: 'Preview',
    ai: 'AI',
    history: 'History',
    assets: 'Assets',
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar',
    resize: 'Resize sidebar',
    overLimit: 'A platform is over its limit',
  },
});
