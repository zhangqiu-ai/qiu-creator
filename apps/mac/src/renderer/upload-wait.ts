import type { AssetRecord } from '@qiu-creator/contracts';
import type { CreatorHubBridge, UploadItem } from '../shared/bridge.js';
import { uploadErrorText } from './editor-insert.js';

export type UploadBridge = Pick<
  CreatorHubBridge,
  'insertBytes' | 'insertFiles' | 'onUploads' | 'uploads'
>;

/** An upload that failed or was cancelled, worded for the interface. */
export class UploadFailed extends Error {
  constructor(readonly item: Pick<UploadItem, 'error' | 'errorCode'>) {
    super(uploadErrorText(item));
  }
}

/** Resolve with the library asset once the main process's upload `id` succeeds. */
export function waitForUpload(bridge: UploadBridge, id: string): Promise<AssetRecord> {
  return new Promise((resolve, reject) => {
    let done = false;
    const check = (items: readonly UploadItem[]) => {
      const item = items.find((i) => i.id === id);
      if (done || item === undefined) return;
      if (item.state === 'succeeded' && item.result !== null) {
        done = true;
        off();
        resolve(item.result.asset);
      } else if (item.state === 'failed' || item.state === 'cancelled') {
        done = true;
        off();
        reject(new UploadFailed(item));
      }
    };
    const off = bridge.onUploads(check);
    // It may have finished before we subscribed.
    void bridge.uploads().then(check, () => undefined);
  });
}

/**
 * Upload bytes made in the renderer (a frame grabbed from the player, QC-046)
 * as an image asset, and wait for it.
 */
export async function uploadBlob(
  bridge: UploadBridge,
  name: string,
  blob: Blob,
): Promise<AssetRecord> {
  const id = await bridge.insertBytes(name, new Uint8Array(await blob.arrayBuffer()));
  return waitForUpload(bridge, id);
}

/** Upload a picked file (another cover image) and wait for it. */
export async function uploadFile(bridge: UploadBridge, file: File): Promise<AssetRecord> {
  const [id] = await bridge.insertFiles([file]);
  if (id === undefined) throw new Error('nothing was queued');
  return waitForUpload(bridge, id);
}
