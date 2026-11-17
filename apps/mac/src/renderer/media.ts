import type { MediaRef, MediaRefStatus, WorkMediaResponse } from '@qiu-creator/contracts';

/**
 * Why Markdown images use the service's signed URLs (QC-010) rather than the
 * `qc-asset://` proxy: only `GET /works/:id/media` knows how a relative path
 * maps to a file (managed `assets/…` or a path inside the mount), and some
 * resolved files have no asset id the proxy could name. Signed URLs are
 * short-lived and scoped to one file, so the owner token still never reaches
 * the renderer, and the same mechanism works for the phase-two WebView.
 */

/** Refresh this long before `expires_at`, so an image never starts loading on a dying URL. */
const EXPIRY_MARGIN_MS = 30_000;

export type Placeholder = Exclude<MediaRefStatus, 'resolved' | 'inline'> | 'unsaved';

const PLACEHOLDER_TEXT: Readonly<Record<Placeholder, string>> = {
  missing: '找不到圖片',
  rejected: '路徑不允許',
  unsupported: '不支援的格式',
  remote: '外部網址圖片未載入',
  unsaved: '儲存後顯示',
};

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A neutral inline SVG with a short reason and the path, instead of a broken-image icon. */
export function placeholderImage(kind: Placeholder, detail: string): string {
  const shown = detail.length > 60 ? `…${detail.slice(-59)}` : detail;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120" viewBox="0 0 480 120">` +
    `<rect x="1" y="1" width="478" height="118" rx="10" fill="#EFEDE7" stroke="#C9C5BB" stroke-dasharray="6 5"/>` +
    `<text x="240" y="56" text-anchor="middle" font-family="-apple-system, PingFang TC, sans-serif" font-size="15" fill="#55524C">${escapeXml(PLACEHOLDER_TEXT[kind])}</text>` +
    `<text x="240" y="82" text-anchor="middle" font-family="SF Mono, Menlo, monospace" font-size="12" fill="#6B6862">${escapeXml(shown)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export interface WorkMediaResolverOptions {
  load: () => Promise<WorkMediaResponse>;
  /** Server-relative signed URL → absolute URL. */
  absolute: (relative: string) => string;
  /** Called before refetching for an unknown `src`, e.g. to save the draft first. */
  beforeLookup?: () => Promise<void>;
  now?: () => number;
}

/**
 * Resolves image `src` values for one work. One `/media` call serves every
 * image until the signed URLs near expiry; concurrent lookups share it.
 */
export class WorkMediaResolver {
  private refs = new Map<string, MediaRef>();
  private expiresAt = 0;
  private loading: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: WorkMediaResolverOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Forget cached URLs (the work's Markdown or assets changed). */
  invalidate(): void {
    this.expiresAt = 0;
  }

  private fresh(): boolean {
    return this.now() < this.expiresAt - EXPIRY_MARGIN_MS;
  }

  private refresh(): Promise<void> {
    this.loading ??= this.options
      .load()
      .then((res) => {
        this.refs = new Map(res.items.map((r) => [r.src, r]));
        this.expiresAt = Date.parse(res.expires_at);
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async resolve(src: string): Promise<string> {
    if (src.startsWith('data:')) return src;
    if (/^https?:\/\//i.test(src)) return placeholderImage('remote', src);
    if (!this.fresh() || !this.refs.has(src)) {
      // A new image reference only resolves once the Markdown containing it is saved.
      if (this.fresh() && !this.refs.has(src)) await this.options.beforeLookup?.();
      try {
        await this.refresh();
      } catch {
        return placeholderImage('missing', src);
      }
    }
    const ref = this.refs.get(src);
    if (ref === undefined) return placeholderImage('unsaved', src);
    switch (ref.status) {
      case 'resolved':
        return ref.url === null ? placeholderImage('missing', src) : this.options.absolute(ref.url);
      case 'inline':
        return src;
      default:
        return placeholderImage(ref.status, ref.path ?? src);
    }
  }
}
