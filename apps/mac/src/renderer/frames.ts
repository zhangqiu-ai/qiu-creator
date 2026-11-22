/**
 * Video frames grabbed in the renderer (QC-046, PT-20261121-001 decision:
 * the App captures the cover from the player and uploads it as an image
 * asset; the service bundles no ffmpeg). The `qc-asset://` scheme allows
 * this app's origin, and the videos are loaded `crossorigin`, so the canvas
 * is never tainted.
 */

const LOAD_TIMEOUT_MS = 15_000;

function once(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`video ${event} timed out`));
    }, LOAD_TIMEOUT_MS);
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('video failed to load'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, ok);
      target.removeEventListener('error', fail);
    };
    target.addEventListener(event, ok);
    target.addEventListener('error', fail);
  });
}

/** Draw the frame a video shows right now; `maxWidth` scales it down (thumbnails). */
export function drawFrame(video: HTMLVideoElement, maxWidth?: number): HTMLCanvasElement {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const scale = maxWidth !== undefined && w > maxWidth ? maxWidth / w : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function canvasBlob(canvas: HTMLCanvasElement, type = 'image/jpeg'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error('could not encode the frame'));
        else resolve(blob);
      },
      type,
      0.92,
    );
  });
}

/**
 * Grabs frames of one video at given times with a hidden player. Seeks run
 * one at a time; `dispose` releases the element.
 */
export class FrameGrabber {
  private readonly video: HTMLVideoElement;
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(src: string) {
    this.video = document.createElement('video');
    this.video.crossOrigin = 'anonymous';
    this.video.muted = true;
    this.video.preload = 'auto';
    this.ready = once(this.video, 'loadeddata');
    this.video.src = src;
  }

  private async seek(time: number): Promise<void> {
    await this.ready;
    const target = Math.max(0, Math.min(time, (this.video.duration || time) - 0.05));
    if (Math.abs(this.video.currentTime - target) < 0.01) return;
    const seeked = once(this.video, 'seeked');
    this.video.currentTime = target;
    await seeked;
  }

  /** A small JPEG data URL for the frame strip. */
  thumbnail(time: number, maxWidth = 160): Promise<string> {
    return this.run(async () => {
      await this.seek(time);
      return drawFrame(this.video, maxWidth).toDataURL('image/jpeg', 0.8);
    });
  }

  /** The full-size frame, to upload as the cover. */
  frame(time: number): Promise<Blob> {
    return this.run(async () => {
      await this.seek(time);
      return canvasBlob(drawFrame(this.video));
    });
  }

  /** A frame scaled so its longest edge is at most `maxEdge`, as JPEG (library cards, QC-061). */
  scaledFrame(time: number, maxEdge: number): Promise<Blob> {
    return this.run(async () => {
      await this.seek(time);
      const { videoWidth: w, videoHeight: h } = this.video;
      const width = w >= h ? Math.min(w, maxEdge) : Math.round((w * Math.min(h, maxEdge)) / h);
      return canvasBlob(drawFrame(this.video, width), 'image/jpeg');
    });
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    this.video.removeAttribute('src');
    this.video.load();
  }
}
