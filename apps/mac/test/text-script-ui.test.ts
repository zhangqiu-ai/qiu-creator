import { describe, expect, it } from 'vitest';
import {
  choiceLabel,
  choiceOf,
  effectiveScript,
  followLabel,
  PROJECT_SCRIPT_CHOICES,
  SCRIPT_OPTIONS,
  scriptName,
  valueOf,
} from '../src/renderer/text-script-ui.js';

describe('作品文字字體 choices (QC-109)', () => {
  it('offers 簡體 and 繁體 globally, and 跟隨全域 first for a project', () => {
    expect(SCRIPT_OPTIONS).toEqual(['zh-Hans', 'zh-Hant']);
    expect(PROJECT_SCRIPT_CHOICES).toEqual(['follow', 'zh-Hans', 'zh-Hant']);
  });

  it('maps a project value to a choice and back; null and absent follow the global setting', () => {
    expect(choiceOf(null)).toBe('follow');
    expect(choiceOf(undefined)).toBe('follow');
    expect(choiceOf('zh-Hant')).toBe('zh-Hant');
    expect(valueOf('follow')).toBeNull();
    expect(valueOf('zh-Hans')).toBe('zh-Hans');
    for (const c of PROJECT_SCRIPT_CHOICES) expect(choiceOf(valueOf(c))).toBe(c);
  });

  it('names the scripts, and the global one inside 跟隨全域 once it is known', () => {
    expect(scriptName('zh-Hans')).toBe('簡體');
    expect(scriptName('zh-Hant')).toBe('繁體');
    expect(followLabel('zh-Hant')).toBe('跟隨全域（繁體）');
    expect(followLabel(null)).toBe('跟隨全域');
    expect(choiceLabel('follow', 'zh-Hans')).toBe('跟隨全域（簡體）');
    expect(choiceLabel('zh-Hant', 'zh-Hans')).toBe('繁體');
  });

  it('works out the script agent text ends up in: project, else global, else 簡體', () => {
    expect(effectiveScript('zh-Hant', 'zh-Hans')).toBe('zh-Hant');
    expect(effectiveScript(null, 'zh-Hant')).toBe('zh-Hant');
    expect(effectiveScript(undefined, null)).toBe('zh-Hans');
  });
});
