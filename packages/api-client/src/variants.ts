import {
  GenerateVariantsRequestSchema,
  GenerateVariantsResponseSchema,
  PlatformVariantRecordSchema,
  VariantListResponseSchema,
  VariantRevisionListResponseSchema,
  VariantRevisionSchema,
  type GenerateVariantsRequest,
  type GenerateVariantsResponse,
  type PatchVariantRequest,
  type Platform,
  type PlatformVariantRecord,
  type VariantListResponse,
  type VariantRevision,
  type VariantRevisionListResponse,
} from '@qiu-creator/contracts';
import { z } from 'zod';
import { call, type Ctx } from './imports.js';

export interface VariantWriteOptions {
  /** Variant revision sent as `If-Match: "<n>"`, in addition to (or instead of) `base_revision`. */
  ifMatch?: number;
}

/**
 * Platform variants (QC-009). Every write needs the revision it was based on;
 * a stale one throws `ApiError` 409 whose `currentVariantRevision` is the latest.
 */
export interface CreatorHubVariantsApi {
  list(workId: string): Promise<VariantListResponse>;
  get(workId: string, platform: Platform): Promise<PlatformVariantRecord>;
  /** Rule-based drafts (no AI) for platforms without a variant; existing ones are skipped. */
  generate(workId: string, input?: GenerateVariantsRequest): Promise<GenerateVariantsResponse>;
  /** Regenerate one draft from the original; `baseRevision` is required when it already exists. */
  redraft(
    workId: string,
    platform: Platform,
    baseRevision?: number,
  ): Promise<PlatformVariantRecord>;
  patch(
    workId: string,
    platform: Platform,
    input: PatchVariantRequest,
    options?: VariantWriteOptions,
  ): Promise<PlatformVariantRecord>;
  remove(workId: string, platform: Platform, revision: number): Promise<void>;
  revisions(workId: string, platform: Platform): Promise<VariantRevisionListResponse>;
  revision(workId: string, platform: Platform, revision: number): Promise<VariantRevision>;
}

const ifMatch = (revision: number | undefined): Record<string, string> =>
  revision === undefined ? {} : { 'if-match': `"${String(revision)}"` };

export function createVariantsApi(ctx: Ctx): CreatorHubVariantsApi {
  const all = (workId: string): string => `/api/v1/works/${encodeURIComponent(workId)}/variants`;
  const one = (workId: string, platform: Platform): string =>
    `${all(workId)}/${encodeURIComponent(platform)}`;
  return {
    list: (workId) => call(ctx, VariantListResponseSchema, 'GET', all(workId)),
    get: (workId, platform) => call(ctx, PlatformVariantRecordSchema, 'GET', one(workId, platform)),
    generate: (workId, input = {}) =>
      call(
        ctx,
        GenerateVariantsResponseSchema,
        'POST',
        all(workId),
        GenerateVariantsRequestSchema.parse(input),
      ),
    redraft: (workId, platform, baseRevision) =>
      call(
        ctx,
        PlatformVariantRecordSchema,
        'POST',
        `${one(workId, platform)}/draft`,
        baseRevision === undefined ? {} : { base_revision: baseRevision },
      ),
    patch: (workId, platform, input, options = {}) =>
      call(
        ctx,
        PlatformVariantRecordSchema,
        'PATCH',
        one(workId, platform),
        input,
        ifMatch(options.ifMatch),
      ),
    remove: async (workId, platform, revision) => {
      await call(ctx, z.null(), 'DELETE', one(workId, platform), undefined, ifMatch(revision));
    },
    revisions: (workId, platform) =>
      call(ctx, VariantRevisionListResponseSchema, 'GET', `${one(workId, platform)}/revisions`),
    revision: (workId, platform, revision) =>
      call(
        ctx,
        VariantRevisionSchema,
        'GET',
        `${one(workId, platform)}/revisions/${String(revision)}`,
      ),
  };
}
