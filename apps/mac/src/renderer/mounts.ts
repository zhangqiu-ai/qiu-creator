import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Mount, Work } from '@qiu-creator/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useRefreshOn } from './events.js';
import { tildePath } from './format.js';
import { t } from './i18n.js';

/** Mounts by id, refreshed when works change (scans, missing and restored files). */
export function useMounts(client: CreatorHubClient): ReadonlyMap<string, Mount> {
  const [mounts, setMounts] = useState<ReadonlyMap<string, Mount>>(new Map());
  const load = useCallback(() => {
    client.mounts
      .list()
      .then((res) => {
        setMounts(new Map(res.items.map((m) => [m.id, m])));
      })
      .catch(() => {
        // Labels fall back to the generic "外部掛載".
      });
  }, [client]);
  useEffect(load, [load]);
  useRefreshOn(['work'], load, 1000);
  return mounts;
}

export interface ExternalSource {
  /** Short label for chips: `外部掛載 · 寫作`. */
  label: string;
  /** The mount folder, `~/Documents/寫作`. */
  folder: string | null;
  /** Full path of the file, for tooltips and the missing-file banner. */
  file: string | null;
}

/** Where an external work lives, in the prototype's words. Null for managed works. */
export function externalSource(
  work: Pick<Work, 'storage_mode' | 'mount_id' | 'external_path'>,
  mounts: ReadonlyMap<string, Mount>,
  userHome: string | null,
): ExternalSource | null {
  if (work.storage_mode !== 'external') return null;
  const mount =
    work.mount_id === null || work.mount_id === undefined ? undefined : mounts.get(work.mount_id);
  if (mount === undefined) {
    return { label: t('format.sourceExternal'), folder: null, file: work.external_path ?? null };
  }
  const folder = tildePath(mount.root_path, userHome);
  const rel = work.external_path ?? null;
  return {
    label: t('assets.groupExternal', { name: mount.name }),
    folder,
    file: rel === null ? folder : `${folder}/${rel}`,
  };
}
