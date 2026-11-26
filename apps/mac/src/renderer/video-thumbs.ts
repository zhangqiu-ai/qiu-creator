import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { assetMediaUrl } from '../shared/bridge.js';
import { thumbTime } from './asset-viewer.js';
import { FrameGrabber } from './frames.js';

/**
 * Thumbnails of video assets (QC-108). The service makes thumbnails for images
 * only, so a video card used to show an icon. The App grabs one small frame of
 * each video card that comes into view, with a hidden player (never a
 * `<video>` in the grid), one video at a time, and keeps it in memory for the
 * session. A video Chromium cannot decode keeps the icon.
 */

export type GrabThumb = (src: string, timeSeconds: number) => Promise<string>;

/** Longest edge of a card frame: a grid card is at most ~200px wide on a Retina screen. */
export const VIDEO_THUMB_WIDTH = 320;

const grabThumb: GrabThumb = async (src, time) => {
  const grabber = new FrameGrabber(src);
  try {
    return await grabber.thumbnail(time, VIDEO_THUMB_WIDTH);
  } finally {
    grabber.dispose();
  }
};

/** A frame, `null` when it could not be taken, `undefined` while not tried yet. */
export type ThumbState = string | null | undefined;

interface Job {
  id: string;
  src: string;
  time: number;
}

export class VideoThumbs {
  private readonly done = new Map<string, string | null>();
  private readonly queue: Job[] = [];
  private readonly queued = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private running = false;

  constructor(
    private readonly grab: GrabThumb = grabThumb,
    /** Frames kept; the oldest go first (data URLs of ~10–20 KB each). */
    private readonly max = 400,
  ) {}

  get(id: string): ThumbState {
    return this.done.get(id);
  }

  /** Ask for a frame; repeated asks and finished ones are ignored. */
  request(id: string, src: string, duration: number | null): void {
    if (this.done.has(id) || this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push({ id, src, time: thumbTime(duration) });
    void this.pump();
  }

  /** Drop a request for a card that left the view before its turn. */
  cancel(id: string): void {
    const at = this.queue.findIndex((j) => j.id === id);
    if (at < 0) return;
    this.queue.splice(at, 1);
    this.queued.delete(id);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job !== undefined; job = this.queue.shift()) {
        let frame: string | null;
        try {
          frame = await this.grab(job.src, job.time);
        } catch {
          frame = null;
        }
        this.queued.delete(job.id);
        this.done.set(job.id, frame);
        while (this.done.size > this.max) {
          const oldest = this.done.keys().next().value;
          if (oldest === undefined) break;
          this.done.delete(oldest);
        }
        for (const l of this.listeners) l();
      }
    } finally {
      this.running = false;
    }
  }
}

/** One queue for the App, so a frame taken in the grid also serves the filmstrip and 回收站. */
export const videoThumbs = new VideoThumbs();

/**
 * The frame for a video asset's card, asked for once the element is on screen.
 * Other kinds always get `undefined`.
 */
export function useVideoThumb(
  asset: { id: string; kind: string; duration: number | null },
  target: RefObject<Element | null>,
  thumbs: VideoThumbs = videoThumbs,
): ThumbState {
  const isVideo = asset.kind === 'video';
  const state = useSyncExternalStore(thumbs.subscribe, () =>
    isVideo ? thumbs.get(asset.id) : undefined,
  );
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (!isVideo || state !== undefined || el === null) return;
    const io = new IntersectionObserver((entries) => {
      setSeen(entries.some((e) => e.isIntersecting));
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [isVideo, state, target]);
  useEffect(() => {
    if (!isVideo || !seen || state !== undefined) return;
    thumbs.request(asset.id, assetMediaUrl(asset.id), asset.duration);
    return () => {
      thumbs.cancel(asset.id);
    };
  }, [isVideo, seen, state, thumbs, asset.id, asset.duration]);
  return state;
}
