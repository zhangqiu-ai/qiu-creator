import { THUMBNAIL_FRAME_MAX_BYTES } from '@qiu-creator/contracts';

/**
 * A video frame for a library card (QC-061), uploaded by the main process:
 * the renderer's request bridge only carries text, and only the main process
 * holds the token. Everything the renderer passes is checked here, so the
 * call can reach nothing but `PUT /api/v1/works/<uuid>/thumbnail-frame`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9a-f]{16}$/;

export interface CardFrameMeta {
  version: string;
  /** `card_image.frame_source.path`. */
  source: string;
  timeSeconds: number;
}

export interface CardFrameResult {
  ok: boolean;
  status: number;
  /** The service's error code (e.g. `thumbnail_frame_stale`), or null. */
  code: string | null;
}

/** The service path and body to send, or null when anything is out of bounds. */
export function cardFrameRequest(
  workId: unknown,
  data: unknown,
  meta: unknown,
): { path: string; body: Uint8Array } | null {
  if (typeof workId !== 'string' || !UUID.test(workId)) return null;
  if (!(data instanceof Uint8Array) || data.byteLength === 0) return null;
  if (data.byteLength > THUMBNAIL_FRAME_MAX_BYTES) return null;
  if (typeof meta !== 'object' || meta === null) return null;
  const m = meta as Record<string, unknown>;
  const { version, source, timeSeconds } = m;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  if (typeof source !== 'string' || source === '' || source.length > 4096) return null;
  if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds) || timeSeconds < 0) {
    return null;
  }
  const query = new URLSearchParams({
    version,
    source,
    time_seconds: String(timeSeconds),
  });
  return {
    path: `/api/v1/works/${workId.toLowerCase()}/thumbnail-frame?${query.toString()}`,
    body: data,
  };
}
