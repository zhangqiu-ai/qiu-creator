import {
  GenerateVariantsRequestSchema,
  GenerateVariantViewsResponseSchema,
  VariantOverrideRevisionListResponseSchema,
  VariantOverrideRevisionSchema,
  VariantViewListResponseSchema,
  VariantViewSchema,
  type GenerateVariantsRequest,
  type GenerateVariantViewsResponse,
  type PatchVariantOverridesRequest,
  type Platform,
  type VariantOverrideRevision,
  type VariantOverrideRevisionListResponse,
  type VariantView,
  type VariantViewListResponse,
} from '@qiu-creator/contracts';
import { z } from 'zod';
import { call, type Ctx } from './imports.js';

export interface VariantWriteOptions {
  /** Variant revision sent as `If-Match: "<n>"`, in addition to (or instead of) `base_revision`. */
  ifMatch?: number;
}

/**
 * Platform variants (QC-009, overrides since QC-084). A variant is the work
 * as a platform shows it: title, cover, image order and tags can be
 * overridden, the body is always derived from the work. Every write needs
 * the revision it was based on (0 before the first override); a stale one
 * throws `ApiError` 409 whose `currentVariantRevision` is the latest.
 */
export interface CreatorHubVariantsApi {
  /** All four platforms, resolved. */
  list(workId: string): Promise<VariantViewListResponse>;
  get(workId: string, platform: Platform): Promise<VariantView>;
  /** Set overrides (a value) or follow the work again (null). */
  patch(
    workId: string,
    platform: Platform,
    input: PatchVariantOverridesRequest,
    options?: VariantWriteOptions,
  ): Promise<VariantView>;
  /** Drop every override of a platform (history is kept); needs the current revision. */
  remove(workId: string, platform: Platform, revision: number): Promise<void>;
  revisions(workId: string, platform: Platform): Promise<VariantOverrideRevisionListResponse>;
  revision(workId: string, platform: Platform, revision: number): Promise<VariantOverrideRevision>;
  /** Deprecated (QC-084): variants need no generating; creates rows without overrides. */
  generate(workId: string, input?: GenerateVariantsRequest): Promise<GenerateVariantViewsResponse>;
  /** Deprecated (QC-084): same as clearing every override (`remove`, or `patch` with nulls). */
  redraft(workId: string, platform: Platform, baseRevision?: number): Promise<VariantView>;
}

const ifMatch = (revision: number | undefined): Record<string, string> =>
  revision === undefined ? {} : { 'if-match': `"${String(revision)}"` };

export function createVariantsApi(ctx: Ctx): CreatorHubVariantsApi {
  const all = (workId: string): string => `/api/v1/works/${encodeURIComponent(workId)}/variants`;
  const one = (workId: string, platform: Platform): string =>
    `${all(workId)}/${encodeURIComponent(platform)}`;
  return {
    list: (workId) => call(ctx, VariantViewListResponseSchema, 'GET', all(workId)),
    get: (workId, platform) => call(ctx, VariantViewSchema, 'GET', one(workId, platform)),
    patch: (workId, platform, input, options = {}) =>
      call(ctx, VariantViewSchema, 'PATCH', one(workId, platform), input, ifMatch(options.ifMatch)),
    remove: async (workId, platform, revision) => {
      await call(ctx, z.null(), 'DELETE', one(workId, platform), undefined, ifMatch(revision));
    },
    revisions: (workId, platform) =>
      call(
        ctx,
        VariantOverrideRevisionListResponseSchema,
        'GET',
        `${one(workId, platform)}/revisions`,
      ),
    revision: (workId, platform, revision) =>
      call(
        ctx,
        VariantOverrideRevisionSchema,
        'GET',
        `${one(workId, platform)}/revisions/${String(revision)}`,
      ),
    generate: (workId, input = {}) =>
      call(
        ctx,
        GenerateVariantViewsResponseSchema,
        'POST',
        all(workId),
        GenerateVariantsRequestSchema.parse(input),
      ),
    redraft: (workId, platform, baseRevision) =>
      call(
        ctx,
        VariantViewSchema,
        'POST',
        `${one(workId, platform)}/draft`,
        baseRevision === undefined ? {} : { base_revision: baseRevision },
      ),
  };
}
