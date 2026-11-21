import { describe, expect, it } from 'vitest';
import {
  charCount,
  checkVariantLimits,
  imagesLimit,
  ListWorksQuerySchema,
  PatchVariantRequestSchema,
  PatchWorkRequestSchema,
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

describe('image posts and video works (QC-045/046)', () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  it('warns past 20 images for a 公眾號 image post, but not for an article', () => {
    expect(PLATFORM_LIMITS.wechat_mp.imagePostImagesMax).toBe(20);
    expect(imagesLimit('wechat_mp', 'image')).toBe(20);
    expect(imagesLimit('wechat_mp', 'article')).toBeNull();
    expect(imagesLimit('xiaohongshu', 'image')).toBe(18);
    const v = { ...empty, image_asset_ids: ids(21) };
    expect(checkVariantLimits('wechat_mp', v, PLATFORM_LIMITS, 'image')).toEqual([
      expect.objectContaining({ code: 'too_many_images', limit: 20, actual: 21 }),
    ]);
    expect(checkVariantLimits('wechat_mp', v)).toEqual([]);
    expect(
      checkVariantLimits(
        'wechat_mp',
        { ...empty, image_asset_ids: ids(20) },
        PLATFORM_LIMITS,
        'image',
      ),
    ).toEqual([]);
  });

  it('takes images, cover and inherit on a variant patch, one name at a time', () => {
    const [a] = ids(1);
    expect(PatchVariantRequestSchema.parse({ inherit: true })).toEqual({ inherit: true });
    expect(PatchVariantRequestSchema.parse({ cover: { time_seconds: 3 } }).cover).toEqual({
      time_seconds: 3,
    });
    expect(() =>
      PatchVariantRequestSchema.parse({ cover: { asset_id: a, time_seconds: 1 } }),
    ).toThrow();
    expect(() => PatchVariantRequestSchema.parse({ images: [a], image_asset_ids: [a] })).toThrow();
    expect(() => PatchVariantRequestSchema.parse({ cover: null, cover_asset_id: null })).toThrow();
  });

  it('accepts the typed work fields on a work patch and the ids query', () => {
    const [a, b] = ids(2);
    expect(
      PatchWorkRequestSchema.parse({ images: [a, b], cover: { asset_id: a }, description: 'x' }),
    ).toMatchObject({ images: [a, b] });
    expect(() => PatchWorkRequestSchema.parse({ images: [a, a] })).toThrow();
    expect(() => PatchWorkRequestSchema.parse({ markdown: 'x', description: 'y' })).toThrow();
    expect(() => PatchWorkRequestSchema.parse({ ai_job_id: a })).toThrow();
    expect(PatchWorkRequestSchema.parse({ video_asset_id: null })).toEqual({
      video_asset_id: null,
    });
    expect(
      ListWorksQuerySchema.parse({ ids: ` ${String(a)}, ${String(b)},${String(a)} ` }).ids,
    ).toEqual([a, b]);
    expect(() => ListWorksQuerySchema.parse({ ids: 'not-an-id' })).toThrow();
    expect(() => ListWorksQuerySchema.parse({ ids: ids(201).join(',') })).toThrow();
  });
});
