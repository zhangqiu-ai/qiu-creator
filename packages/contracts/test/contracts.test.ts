import { describe, expect, it } from 'vitest';
import {
  CreateWorkRequestSchema,
  ErrorResponseSchema,
  ListWorksQuerySchema,
  PatchWorkRequestSchema,
  PlatformSchema,
  WorkSchema,
} from '../src/index.js';

describe('contracts', () => {
  it('fixes the four supported platforms', () => {
    expect(PlatformSchema.options).toEqual([
      'xiaohongshu',
      'wechat_mp',
      'douyin',
      'wechat_channels',
    ]);
  });

  it('fills defaults when creating a work', () => {
    expect(CreateWorkRequestSchema.parse({ title: ' 標題 ' })).toEqual({
      title: '標題',
      markdown: '',
      type: 'article',
      status: 'drafting',
      tags: [],
      source: 'api',
    });
  });

  it('requires at least one editable field on PATCH', () => {
    expect(PatchWorkRequestSchema.safeParse({ base_revision: crypto.randomUUID() }).success).toBe(
      false,
    );
    expect(
      PatchWorkRequestSchema.safeParse({ base_revision: crypto.randomUUID(), title: 'x' }).success,
    ).toBe(true);
  });

  it('coerces list query strings and bounds the page size', () => {
    expect(ListWorksQuerySchema.parse({ limit: '10', offset: '5' })).toMatchObject({
      limit: 10,
      offset: 5,
    });
    expect(ListWorksQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('rejects unknown work statuses and non-uuid ids', () => {
    const base = {
      id: crypto.randomUUID(),
      title: 't',
      type: 'article',
      status: 'drafting',
      tags: [],
      source: 'api',
      storage_mode: 'managed',
      current_revision_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(WorkSchema.safeParse(base).success).toBe(true);
    expect(WorkSchema.safeParse({ ...base, status: 'archived' }).success).toBe(false);
    expect(WorkSchema.safeParse({ ...base, id: '../x' }).success).toBe(false);
  });

  it('describes errors uniformly', () => {
    expect(
      ErrorResponseSchema.safeParse({
        error: { code: 'revision_conflict', message: 'm', details: { a: 1 } },
      }).success,
    ).toBe(true);
    expect(ErrorResponseSchema.safeParse({ error: 'boom' }).success).toBe(false);
  });
});
