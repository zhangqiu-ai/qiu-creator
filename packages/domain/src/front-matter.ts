import { isMap, isSeq, parseDocument, type Document } from 'yaml';

/**
 * Image-post and video works (QC-045/046) are Markdown with YAML front matter:
 *
 *     ---
 *     type: image
 *     title: 京都秋天
 *     images:
 *       - assets/a.png
 *       - assets/b.png
 *     cover: assets/a.png        # or: cover: { time_seconds: 12.5 }
 *     video: assets/clip.mp4
 *     tags: [旅行, 京都]
 *     ---
 *     The description (plain text).
 *
 * Paths are relative to the Markdown file's folder. Keys this app does not
 * know, their order and comments are kept when it writes the file.
 */

/** Cover of a work: one of its image files, or a frame of its video. */
export type WorkCover = { path: string } | { time_seconds: number };

export interface WorkFrontMatter {
  type: string | null;
  title: string | null;
  /** Ordered, relative to the Markdown file. */
  images: string[];
  cover: WorkCover | null;
  video: string | null;
  tags: string[];
}

export interface ParsedWorkSource {
  /** Null when the file has no front matter (articles, or a description only). */
  frontMatter: WorkFrontMatter | null;
  /** The Markdown after the front matter: the description of an image or video work. */
  body: string;
  /** Front matter exists but is not valid YAML or not a mapping; the file must not be rewritten. */
  invalid: boolean;
  /** Fields present with an unusable shape (e.g. `images: 3`); they read as empty. */
  warnings: string[];
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /\r?\n---[ \t]*(?:\r?\n|$)/;

function split(markdown: string): { yaml: string; body: string } | null {
  const open = OPEN.exec(markdown);
  if (open === null) return null;
  const rest = markdown.slice(open[0].length);
  // Empty front matter: `---\n---\n`.
  const empty = /^---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (empty !== null) return { yaml: '', body: rest.slice(empty[0].length) };
  const close = CLOSE.exec(rest);
  if (close === null) return null;
  return { yaml: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readCover(value: unknown, warnings: string[]): WorkCover | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : { path: value };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const t = (value as Record<string, unknown>)['time_seconds'];
    if (typeof t === 'number' && Number.isFinite(t) && t >= 0) return { time_seconds: t };
  }
  warnings.push('cover');
  return null;
}

function readStrings(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(field);
    return [];
  }
  const out = (value as unknown[])
    .map((v): unknown => (typeof v === 'number' ? String(v) : v))
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (out.length !== value.length) warnings.push(field);
  return out;
}

export function parseWorkSource(markdown: string): ParsedWorkSource {
  const parts = split(markdown);
  if (parts === null) return { frontMatter: null, body: markdown, invalid: false, warnings: [] };
  const doc = parseDocument(parts.yaml);
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
    return { frontMatter: null, body: parts.body, invalid: true, warnings: [] };
  }
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];
  return {
    frontMatter: {
      type: stringOrNull(data['type']),
      title: stringOrNull(data['title']),
      images: readStrings(data['images'], 'images', warnings),
      cover: readCover(data['cover'], warnings),
      video: stringOrNull(data['video']),
      tags: readStrings(data['tags'], 'tags', warnings),
    },
    body: parts.body,
    invalid: false,
    warnings,
  };
}

/** What a write changes; `undefined` leaves a field as it is, `null` removes it. */
export interface WorkSourceChange {
  type?: string;
  title?: string;
  images?: string[];
  cover?: WorkCover | null;
  video?: string | null;
  tags?: string[];
  /** The new description (Markdown body). */
  body?: string;
}

/** Keys this app writes; new ones are added in this order (the calls below follow it). */
type WorkKey = 'type' | 'title' | 'images' | 'cover' | 'video' | 'tags';

/**
 * Apply `change` to a work's Markdown and return the new file text. Unknown
 * keys, their order and comments survive; known keys keep their position and
 * new ones are added in the order above. Throws for invalid front matter, so
 * a file the app cannot read is never overwritten.
 */
export function writeWorkSource(markdown: string, change: WorkSourceChange): string {
  const parts = split(markdown);
  let doc: Document;
  let body: string;
  if (parts === null) {
    doc = parseDocument('{}');
    body = markdown;
  } else {
    doc = parseDocument(parts.yaml === '' ? '{}' : parts.yaml);
    if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
      throw new FrontMatterError('the front matter is not valid YAML; fix it in the file first');
    }
    if (doc.contents === null) doc = parseDocument('{}');
    body = parts.body;
  }

  const set = (key: WorkKey, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) {
      doc.delete(key);
      return;
    }
    const node = doc.createNode(value);
    if (isSeq(node)) node.flow = node.items.length === 0;
    if (isMap(node)) node.flow = true;
    doc.set(key, node);
  };
  set('type', change.type);
  set('title', change.title);
  set('images', change.images);
  set(
    'cover',
    change.cover === undefined
      ? undefined
      : change.cover === null
        ? null
        : 'path' in change.cover
          ? change.cover.path
          : { time_seconds: change.cover.time_seconds },
  );
  set('video', change.video);
  set('tags', change.tags);
  // A flow mapping from parseDocument('{}') would print as one line; use block style.
  if (isMap(doc.contents)) doc.contents.flow = false;

  const yamlText = doc.toString({ lineWidth: 0 });
  const nextBody = change.body ?? body;
  return `---\n${yamlText}---\n${nextBody}`;
}

export class FrontMatterError extends Error {}
