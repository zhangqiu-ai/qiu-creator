import { PLATFORM_LIMITS, type Platform } from '@qiu-creator/contracts';

/**
 * Previews simulate layout and information structure only. They never use the
 * platforms' logos or trademarks; platforms are named in plain text.
 */

export type { Platform };

export const PLATFORMS = [
  'xiaohongshu',
  'wechat_mp',
  'douyin',
  'wechat_channels',
] as const satisfies readonly Platform[];

export type PreviewKind = 'image_post' | 'article' | 'video';

/** Per-platform layout facts. */
export interface PreviewTemplate {
  platform: Platform;
  /** Plain-text platform name; never a logo. */
  displayName: string;
  /** Short name for tabs. */
  shortName: string;
  kinds: readonly PreviewKind[];
  /** Cover aspect ratio as width / height. */
  coverAspectRatio: number;
  coverRatioLabel: string;
  titleMaxChars: number | null;
  bodyPreviewMaxChars: number | null;
  /** Previews are always labelled as simulations. */
  simulated: true;
}

function template(
  platform: Platform,
  displayName: string,
  shortName: string,
  kinds: readonly PreviewKind[],
  coverAspectRatio: number,
  coverRatioLabel: string,
): PreviewTemplate {
  return {
    platform,
    displayName,
    shortName,
    kinds,
    coverAspectRatio,
    coverRatioLabel,
    titleMaxChars: PLATFORM_LIMITS[platform].titleMaxChars,
    bodyPreviewMaxChars: PLATFORM_LIMITS[platform].bodyMaxChars,
    simulated: true,
  };
}

/** Layout facts from the approved prototype (MacPreview); limits come from contracts. */
export const templates: Readonly<Record<Platform, PreviewTemplate>> = {
  xiaohongshu: template('xiaohongshu', '小紅書', '小紅書', ['image_post', 'video'], 3 / 4, '3:4'),
  wechat_mp: template('wechat_mp', '微信公眾號', '公眾號', ['article'], 2.35, '2.35:1'),
  douyin: template('douyin', '抖音', '抖音', ['video', 'image_post'], 9 / 16, '9:16'),
  wechat_channels: template(
    'wechat_channels',
    '微信視頻號',
    '視頻號',
    ['video', 'image_post'],
    6 / 7,
    '6:7',
  ),
};

export function getTemplate(platform: Platform): PreviewTemplate {
  return templates[platform];
}

/** Label shown on every preview surface. */
export const SIMULATED_LABEL = '模擬';

/** A settings row on a platform's publish screen (「標記地點」, 「原創聲明 · 未聲明」 …). */
export interface PlatformUiRow {
  /** A small glyph before the label (emoji or ''); never a logo. */
  icon: string;
  label: string;
  /** Text on the right; '' draws a chevron. */
  value: string;
  /** Show the account name instead of `value` (公眾號 「作者」). */
  author?: true;
}

/** One side button on a full-screen recommend view (likes, comments …). */
export interface PlatformUiCount {
  icon: string;
  value: string;
}

/** A grey placeholder note in the 小紅書 discovery feed. */
export interface PlatformUiFeedCard {
  title: string;
  likes: string;
  /** Placeholder image ratio, width / height. */
  ratio: number;
}

/**
 * The simulated platforms' own interface text (PT-20261123-001 v2). It is the
 * platforms' wording, shown as they look, and is never translated (decisions
 * 2026-11-21). Keys a platform does not use are ''.
 */
export interface PlatformUi {
  /** 發布編輯: centre of the nav bar. */
  publishNavTitle: string;
  /** 發布編輯: right of the nav bar (草稿 / 發表). */
  publishNavAction: string;
  /** Whether `publishNavAction` is the platform's green send action. */
  publishNavActionStrong: boolean;
  titlePlaceholder: string;
  /** 視頻號 「短標題」 above the title field. */
  shortTitleLabel: string;
  /** Rows right under the title (公眾號 作者 / 摘要). */
  infoRows: readonly PlatformUiRow[];
  /** Rows after the tags. */
  settingRows: readonly PlatformUiRow[];
  /** Bottom buttons ('' hides them). */
  draftButton: string;
  publishButton: string;
  /** 刷到時: feed tabs and which one is selected. */
  feedTabs: readonly string[];
  feedActiveTab: number;
  /** 公眾號 訂閱號消息 header, push time and the row below the push. */
  feedHeader: string;
  feedTime: string;
  feedOther: string;
  /** Likes on your own note in the 小紅書 feed. */
  feedOwnLikes: string;
  feedUser: string;
  feedCards: readonly PlatformUiFeedCard[];
  /** Side buttons on 抖音 / 視頻號 recommend views. */
  feedCounts: readonly PlatformUiCount[];
  /** 「展開」 after a clipped description. */
  feedMore: string;
  /** 抖音 bottom tab bar. */
  feedNav: readonly string[];
  /** 正文: the follow button next to the author. */
  followButton: string;
}

const NO_FEED = {
  feedHeader: '',
  feedTime: '',
  feedOther: '',
  feedOwnLikes: '',
  feedUser: '',
  feedCards: [],
  feedCounts: [],
  feedMore: '',
  feedNav: [],
} as const;

export const PLATFORM_UI: Readonly<Record<Platform, PlatformUi>> = {
  xiaohongshu: {
    ...NO_FEED,
    publishNavTitle: '',
    publishNavAction: '草稿',
    publishNavActionStrong: false,
    titlePlaceholder: '填寫標題會有更多讚哦',
    shortTitleLabel: '',
    infoRows: [],
    settingRows: [
      { icon: '📍', label: '標記地點', value: '' },
      { icon: '👁', label: '公開可見', value: '公開 ›' },
    ],
    draftButton: '存草稿',
    publishButton: '發布筆記',
    feedTabs: ['關注', '發現', '附近'],
    feedActiveTab: 1,
    feedOwnLikes: '♡ 128',
    feedUser: '用戶',
    feedCards: [
      { title: '週末市集採買清單', likes: '♡ 2.1萬', ratio: 1 },
      { title: '一人食：15 分鐘番茄牛腩飯', likes: '♡ 2.1萬', ratio: 3 / 4 },
      { title: '秋冬通勤穿搭 5 套', likes: '♡ 2.1萬', ratio: 4 / 5 },
    ],
    followButton: '關注',
  },
  wechat_mp: {
    ...NO_FEED,
    publishNavTitle: '發表文章',
    publishNavAction: '發表',
    publishNavActionStrong: true,
    titlePlaceholder: '請輸入標題',
    shortTitleLabel: '',
    infoRows: [
      { icon: '', label: '作者', value: '', author: true },
      { icon: '', label: '摘要', value: '自動取正文前 54 字 ›' },
    ],
    settingRows: [
      { icon: '', label: '原創聲明', value: '未聲明 ›' },
      { icon: '', label: '留言', value: '開啟 ›' },
      { icon: '', label: '合集', value: '' },
    ],
    draftButton: '',
    publishButton: '',
    feedTabs: [],
    feedActiveTab: 0,
    feedHeader: '訂閱號消息',
    feedTime: '11:42',
    feedOther: '其他訂閱號',
    followButton: '',
  },
  douyin: {
    ...NO_FEED,
    publishNavTitle: '',
    publishNavAction: '',
    publishNavActionStrong: false,
    titlePlaceholder: '添加作品標題',
    shortTitleLabel: '',
    infoRows: [],
    settingRows: [
      { icon: '📍', label: '你在哪裡', value: '' },
      { icon: '🔓', label: '公開 · 所有人可見', value: '' },
      { icon: '💬', label: '允許評論', value: '' },
    ],
    draftButton: '存草稿',
    publishButton: '發布',
    feedTabs: ['關注', '推薦'],
    feedActiveTab: 1,
    feedCounts: [
      { icon: '♥', value: '1.2萬' },
      { icon: '💬', value: '386' },
      { icon: '★', value: '2,104' },
    ],
    feedMore: '展開',
    feedNav: ['首頁', '朋友', '＋', '訊息', '我'],
    followButton: '',
  },
  wechat_channels: {
    ...NO_FEED,
    publishNavTitle: '發表動態',
    publishNavAction: '發表',
    publishNavActionStrong: true,
    titlePlaceholder: '添加短標題（選填）',
    shortTitleLabel: '短標題',
    infoRows: [],
    settingRows: [
      { icon: '📍', label: '所在位置', value: '' },
      { icon: '🖼', label: '設置封面', value: '已設置 ›' },
      { icon: '🔗', label: '擴展鏈接', value: '' },
    ],
    draftButton: '',
    publishButton: '',
    feedTabs: ['關注', '朋友♡', '推薦'],
    feedActiveTab: 2,
    feedCounts: [
      { icon: '♥', value: '856' },
      { icon: '↗', value: '分享' },
      { icon: '💬', value: '42' },
    ],
    followButton: '',
  },
};
