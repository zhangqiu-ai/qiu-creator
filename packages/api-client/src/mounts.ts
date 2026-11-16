import {
  ListMountsResponseSchema,
  MountSchema,
  type CreateMountRequest,
  type ListMountsResponse,
  type Mount,
} from '@qiu-creator/contracts';
import { call, type Ctx } from './imports.js';

/** External folder mounts. Creating, rescanning and removing need the owner token. */
export interface CreatorHubMountsApi {
  create(input: CreateMountRequest): Promise<Mount>;
  list(): Promise<ListMountsResponse>;
  get(id: string): Promise<Mount>;
  rescan(id: string): Promise<Mount>;
  /** Unmount; files on disk are never touched. */
  remove(id: string): Promise<Mount>;
}

export function createMountsApi(ctx: Ctx): CreatorHubMountsApi {
  const one = (id: string): string => `/api/v1/mounts/${encodeURIComponent(id)}`;
  return {
    create: (input) => call(ctx, MountSchema, 'POST', '/api/v1/mounts', input),
    list: () => call(ctx, ListMountsResponseSchema, 'GET', '/api/v1/mounts'),
    get: (id) => call(ctx, MountSchema, 'GET', one(id)),
    rescan: (id) => call(ctx, MountSchema, 'POST', `${one(id)}/rescan`),
    remove: (id) => call(ctx, MountSchema, 'DELETE', one(id)),
  };
}
