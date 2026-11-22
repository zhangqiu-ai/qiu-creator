import type { WorkStatus, WorkType } from '@qiu-creator/contracts';

/**
 * 篩選數量 (QC-067): the counts beside 類型 and 狀態 come from the service's
 * totals for the whole filter, not from the works loaded so far. The service
 * gives works per (type, status); missing pairs are zero.
 */
export type ByTypeStatus = Partial<Record<WorkType, Partial<Record<WorkStatus, number>>>>;

export const WORK_TYPES: readonly WorkType[] = ['article', 'image', 'video', 'mixed'];
export const WORK_STATUSES: readonly WorkStatus[] = ['drafting', 'in_review', 'ready', 'published'];

export type TypeCounts = Record<'all' | WorkType, number>;
export type StatusCounts = Record<'all' | WorkStatus, number>;

function sum(values: Iterable<number | undefined>): number {
  let n = 0;
  for (const v of values) n += v ?? 0;
  return n;
}

/** Works of each type (and in all), whatever their status. */
export function typeCounts(by: ByTypeStatus): TypeCounts {
  const out = { all: 0, article: 0, image: 0, video: 0, mixed: 0 };
  for (const type of WORK_TYPES) {
    out[type] = sum(Object.values(by[type] ?? {}));
    out.all += out[type];
  }
  return out;
}

/** Works in each status among the chosen type ('all': every type). */
export function statusCounts(by: ByTypeStatus, type: 'all' | WorkType): StatusCounts {
  const types = type === 'all' ? WORK_TYPES : [type];
  const out = { all: 0, drafting: 0, in_review: 0, ready: 0, published: 0 };
  for (const status of WORK_STATUSES) {
    out[status] = sum(types.map((t) => by[t]?.[status]));
    out.all += out[status];
  }
  return out;
}
