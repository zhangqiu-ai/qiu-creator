import { assetMediaUrl } from '../shared/bridge.js';
import { FrameGrabber } from './frames.js';

/**
 * Video frames for library cards on a Mac without ffmpeg (QC-061). The service
 * marks such a card `needs_frame`; the App grabs that one frame off-screen
 * with a hidden player (never a `<video>` in the list), uploads it, and the
 * service caches it as the card's thumbnail. One video at a time, each card
 * version at most once per session, so scrolling hundreds of cards stays light.
 */

export interface FrameJob {
  workId: string;
  /** The card_image version the frame is for. */
  version: string;
  assetId: string | null;
  /** Relative to the work's Markdown, as the service named it. */
  path: string;
  timeSeconds: number;
}

/** Longest edge of an uploaded frame; the service scales it to 512 anyway. */
export const FRAME_MAX_EDGE = 1024;

export type GrabFrame = (src: string, timeSeconds: number) => Promise<Blob>;
export type UploadFrame = (job: FrameJob, frame: Blob) => Promise<void>;

/** Grab one frame with a hidden player, its longest edge at most `FRAME_MAX_EDGE`. */
export const grabFrame: GrabFrame = async (src, timeSeconds) => {
  const grabber = new FrameGrabber(src);
  try {
    return await grabber.scaledFrame(timeSeconds, FRAME_MAX_EDGE);
  } finally {
    grabber.dispose();
  }
};

export class CardFrameQueue {
  private readonly seen = new Set<string>();
  private readonly pending: FrameJob[] = [];
  private running = false;

  constructor(
    private readonly upload: UploadFrame,
    private readonly grab: GrabFrame = grabFrame,
    /** Called after each upload, so the list can take the new card_image. */
    private readonly onDone: (job: FrameJob, ok: boolean) => void = () => undefined,
  ) {}

  /** Ask for a frame; a card version already asked for (done or failed) is not asked again. */
  enqueue(job: FrameJob): void {
    const key = `${job.workId}:${job.version}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.pending.push(job);
    void this.drain();
  }

  /** Jobs still waiting (for tests and diagnostics). */
  get waiting(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.pending.shift(); job !== undefined; job = this.pending.shift()) {
        let ok = false;
        // Only a library asset can be streamed to a canvas without tainting it; a work file
        // without one keeps the type icon (the service may still decode it with ffmpeg).
        if (job.assetId !== null) {
          try {
            const frame = await this.grab(assetMediaUrl(job.assetId), job.timeSeconds);
            await this.upload(job, frame);
            ok = true;
          } catch {
            ok = false;
          }
        }
        this.onDone(job, ok);
      }
    } finally {
      this.running = false;
    }
  }
}
