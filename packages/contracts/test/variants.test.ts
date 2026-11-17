import { describe, expect, it } from 'vitest';
import {
  charCount,
  checkVariantLimits,
  PatchVariantRequestSchema,
  PLATFORM_LIMITS,
  PlatformSchema,
} from '../src/index.js';

const empty = { title: '', body: '', image_asset_ids: [], tags: [] };

describe('platform limits', () => {
  it('has reference limits for every platform', () => {
    expect(Object.keys(PLATFORM_LIMITS).sort()).toEqual([...PlatformSchema.options].sort());
    expect(PLATFORM_LIMITS.wechat_mp.bodyFormat).toBe('markdown');
    expect(PLATFORM_LIMITS.xiaohongshu.bodyFormat).toBe('plain');
  });

  it('counts code points, so CJK and emoji count as one', () => {
    expect(charCount('京都')).toBe(2);
    expect(charCount('🍁a')).toBe(2);
  });

  it('warns only above the limit, and skips null limits', () => {
    const t = PLATFORM_LIMITS.xiaohongshu.titleMaxChars ?? 0;
    expect(checkVariantLimits('xiaohongshu', { ...empty, title: 'a'.repeat(t) })).toEqual([]);
    expect(
      checkVariantLimits('xiaohongshu', { ...empty, title: 'a'.repeat(t + 1) }).map((w) => w.code),
    ).toEqual(['title_too_long']);
    const many = Array.from({ length: 500 }, (_, i) => String(i));
    expect(
      checkVariantLimits('wechat_mp', { ...empty, image_asset_ids: many, tags: many }),
    ).toEqual([]);
  });

  it('accepts custom limits', () => {
    const limits = { ...PLATFORM_LIMITS, douyin: { ...PLATFORM_LIMITS.douyin, tagsMax: 1 } };
    expect(checkVariantLimits('douyin', { ...empty, tags: ['a', 'b'] }, limits)[0]).toMatchObject({
      code: 'too_many_tags',
      limit: 1,
      actual: 2,
    });
  });

  it('requires at least one field to patch', () => {
    expect(PatchVariantRequestSchema.safeParse({ base_revision: 1 }).success).toBe(false);
    expect(
      PatchVariantRequestSchema.safeParse({ base_revision: 1, cover_asset_id: null }).success,
    ).toBe(true);
  });
});
