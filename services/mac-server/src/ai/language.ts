import type {
  AiConcreteLanguage,
  AiLanguageSource,
  AiOutputLanguage,
  Platform,
} from '@qiu-creator/contracts';
import { detectLanguage } from '@qiu-creator/domain/search';

/** Names of the output languages, as `{語言}` expands and prompts say them. */
export const LANGUAGE_NAMES: Readonly<Record<AiConcreteLanguage, string>> = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
};

/** When `follow` cannot tell and the app did not say its interface language. */
const FALLBACK_LANGUAGE: AiConcreteLanguage = 'zh-Hant';

/**
 * The language a job writes in (QC-075, PT-20261122-003): the prompt's own
 * setting wins, then the request, then the preference. `follow` detects the
 * source text (`detectLanguage`); when it cannot tell, the interface language.
 */
export function resolveLanguage(input: {
  prompt?: AiOutputLanguage | null | undefined;
  request?: AiOutputLanguage | undefined;
  preference: AiOutputLanguage;
  source: string;
  interfaceLanguage?: AiConcreteLanguage | undefined;
}): { language: AiConcreteLanguage; source: AiLanguageSource } {
  const [chosen, from]: [AiOutputLanguage, AiLanguageSource] =
    input.prompt != null
      ? [input.prompt, 'prompt']
      : input.request !== undefined
        ? [input.request, 'request']
        : [input.preference, 'preference'];
  if (chosen !== 'follow') return { language: chosen, source: from };
  const detected = detectLanguage(input.source);
  if (detected !== null) return { language: detected, source: 'detected' };
  return { language: input.interfaceLanguage ?? FALLBACK_LANGUAGE, source: 'interface' };
}

/**
 * The system-prompt rule for the output language (QC-075): write in that
 * language whatever the source is in, without translating names, URLs,
 * Markdown syntax or image paths.
 */
export function languageRule(language: AiConcreteLanguage, source = '原文'): string {
  switch (language) {
    case 'zh-Hans':
      return `一律使用简体中文输出，即使${source}是繁體中文或其他語言；人名、品牌、網址與 Markdown 語法照原樣保留。`;
    case 'zh-Hant':
      return `一律使用繁體中文輸出，即使${source}是简体中文或其他語言；人名、品牌、網址與 Markdown 語法照原樣保留。`;
    case 'en':
      return 'Write the output in English, even when the source is in Chinese; keep names, URLs and Markdown syntax as they are.';
  }
}

/** Plain-text platform names for prompts and `{平台}` (never logos or trademarks in the UI). */
export const PLATFORM_NAMES: Readonly<Record<Platform, string>> = {
  xiaohongshu: '小紅書',
  wechat_mp: '微信公眾號',
  douyin: '抖音',
  wechat_channels: '微信視頻號',
};
