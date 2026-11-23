import type { Nodes, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import {
  charCount,
  checkVariantLimits,
  PLATFORM_LIMITS,
  type Platform,
  type VariantWarning,
} from '@qiu-creator/contracts';

/**
 * Platform bodies derived from the work (QC-084). A platform variant no
 * longer stores its own body: the server derives it from the saved work and
 * the Mac app derives it from the unsaved editor draft, both with
 * `deriveVariantBody`, so the two always agree. Pure TypeScript with no DOM
 * or Electron dependency, so phase-two iPhone/iPad clients can use it too.
 *
 * Offsets: `text_*` index the derived `text` and `source_*` index the source
 * string, both in UTF-16 code units (JavaScript string indices, the unit
 * CodeMirror uses). Limits count code points; `cutAt`/`sourceOffsetAt` convert.
 */

/** A run of the derived text and the source range it came from. */
export interface SourceMapSegment {
  text_start: number;
  text_end: number;
  source_start: number;
  source_end: number;
}

export type DerivedBlockKind = 'heading' | 'paragraph' | 'item' | 'quote' | 'code' | 'table';

/** One block of the derived body, for rendering and for scroll-following the editor. */
export interface DerivedBlock {
  kind: DerivedBlockKind;
  /** Display text of the block (inline Markdown removed). */
  text: string;
  /** Heading level (1–6) for headings; nesting depth (0 = top) for list items. */
  depth?: number;
  /** Where the block sits in the derived `text`. */
  text_start: number;
  text_end: number;
  /** Where the block sits in the source. */
  source_start: number;
  source_end: number;
}

export interface DerivedBody {
  /** `markdown` for 公眾號 (rendered as an article), `plain` for caption-style platforms. */
  format: 'markdown' | 'plain';
  /** The platform body: Markdown for 公眾號, plain text for the others. */
  text: string;
  blocks: DerivedBlock[];
  /** Ordered, non-overlapping; text between segments (separators, markers) has no source. */
  map: SourceMapSegment[];
}

export interface DeriveOptions {
  /** The work title: a leading `# <title>` heading is dropped, since the title is its own field. */
  title?: string;
  /**
   * `text` when the source is already plain text (the description of image
   * and video works): kept as written. Default `markdown`.
   */
  sourceFormat?: 'markdown' | 'text';
}

// ---- Mapped strings -----------------------------------------------------------

/** A string that remembers, per run, which source range each part came from. */
class Mapped {
  constructor(
    readonly text: string = '',
    readonly segs: readonly SourceMapSegment[] = [],
  ) {}

  static plain(text: string): Mapped {
    return new Mapped(text);
  }

  /** `value` found in `source` between `start` and `end` (exact when it occurs verbatim). */
  static located(value: string, source: string, start: number, end: number): Mapped {
    if (value === '') return new Mapped();
    const at = source.indexOf(value, start);
    const exact = at >= 0 && at + value.length <= end;
    return new Mapped(value, [
      {
        text_start: 0,
        text_end: value.length,
        source_start: exact ? at : start,
        source_end: exact ? at + value.length : end,
      },
    ]);
  }

  static join(parts: readonly Mapped[], separator: string): Mapped {
    let text = '';
    const segs: SourceMapSegment[] = [];
    parts.forEach((part, i) => {
      if (i > 0) text += separator;
      for (const s of part.segs) {
        segs.push({
          ...s,
          text_start: s.text_start + text.length,
          text_end: s.text_end + text.length,
        });
      }
      text += part.text;
    });
    return new Mapped(text, segs);
  }

  prefix(text: string): Mapped {
    return Mapped.join([Mapped.plain(text), this], '');
  }

  slice(from: number, to: number): Mapped {
    const segs: SourceMapSegment[] = [];
    for (const s of this.segs) {
      const a = Math.max(s.text_start, from);
      const b = Math.min(s.text_end, to);
      if (a >= b) continue;
      segs.push({
        text_start: a - from,
        text_end: b - from,
        source_start: Math.min(s.source_start + (a - s.text_start), s.source_end),
        source_end: Math.min(s.source_start + (b - s.text_start), s.source_end),
      });
    }
    return new Mapped(this.text.slice(from, to), segs);
  }

  trim(): Mapped {
    const start = this.text.length - this.text.trimStart().length;
    const end = this.text.trimEnd().length;
    return start >= end ? new Mapped() : this.slice(start, end);
  }
}

// ---- Markdown → plain text ----------------------------------------------------

function parse(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfm(), frontmatter(['yaml', 'toml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])],
  });
}

const startOf = (node: Nodes): number => node.position?.start.offset ?? 0;
const endOf = (node: Nodes): number => node.position?.end.offset ?? 0;

/** Inline text of a node: images, HTML and footnote markers dropped, links keep their text. */
function inline(node: Nodes, source: string): Mapped {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return Mapped.located(node.value, source, startOf(node), endOf(node));
    case 'break':
      return Mapped.plain('\n');
    case 'image':
    case 'imageReference':
    case 'html':
    case 'footnoteReference':
      return new Mapped();
    default:
      return 'children' in node
        ? Mapped.join(
            node.children.map((c) => inline(c, source)),
            '',
          )
        : new Mapped();
  }
}

interface PlainBlock {
  kind: DerivedBlockKind;
  depth?: number;
  node: RootContent;
  body: Mapped;
}

/** Plain text of a block, one entry per output paragraph (same rules as the QC-009 drafts). */
function plainBlocks(node: RootContent, source: string, depth = 0): PlainBlock[] {
  switch (node.type) {
    case 'heading':
    case 'paragraph': {
      const body = inline(node, source).trim();
      if (body.text === '') return [];
      return [
        node.type === 'heading'
          ? { kind: 'heading', depth: node.depth, node, body }
          : { kind: 'paragraph', node, body },
      ];
    }
    case 'list': {
      const lines: Mapped[] = [];
      node.children.forEach((item, i) => {
        const marker = node.ordered === true ? `${String((node.start ?? 1) + i)}. ` : '• ';
        const indent = '  '.repeat(depth);
        const parts = item.children.flatMap((child) =>
          child.type === 'list'
            ? plainBlocks(child, source, depth + 1).map((b) => b.body)
            : [inline(child, source).trim()],
        );
        const [first = new Mapped(), ...rest] = parts.filter((p) => p.text !== '');
        const check = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
        lines.push(first.prefix(`${indent}${marker}${check}`), ...rest);
      });
      return [{ kind: 'item', depth, node, body: Mapped.join(lines, '\n') }];
    }
    case 'blockquote':
      return node.children.flatMap((c) => plainBlocks(c, source, depth));
    case 'code':
      return node.value.trim() === ''
        ? []
        : [
            {
              kind: 'code',
              node,
              body: Mapped.located(node.value, source, startOf(node), endOf(node)),
            },
          ];
    case 'table':
      return [
        {
          kind: 'table',
          node,
          body: Mapped.join(
            node.children.map((row) =>
              Mapped.join(
                row.children.map((cell) => inline(cell, source).trim()),
                ' | ',
              ),
            ),
            '\n',
          ),
        },
      ];
    // Front matter, HTML, rules, definitions and footnote definitions are not post text.
    default:
      return [];
  }
}

/** Front matter nodes (`toml` has no mdast typing, hence the string check). */
const FRONT_MATTER: readonly string[] = ['yaml', 'toml'];
const isFrontMatter = (node: RootContent): boolean => FRONT_MATTER.includes(node.type);

function isTitleHeading(node: RootContent | undefined, title: string | undefined): boolean {
  return (
    title !== undefined &&
    node?.type === 'heading' &&
    node.depth === 1 &&
    inline(node, '').text.trim() === title.trim()
  );
}

/** Blocks after front matter and a leading title heading. */
function bodyNodes(root: Root, title: string | undefined): RootContent[] {
  const children = root.children.filter((n) => !isFrontMatter(n));
  return isTitleHeading(children[0], title) ? children.slice(1) : children;
}

function derivePlain(markdown: string, title: string | undefined): DerivedBody {
  const parts = bodyNodes(parse(markdown), title).flatMap((n) => plainBlocks(n, markdown));
  // Same as joining and trimming the whole text: every part is already trimmed
  // except list lines, which may start with an indent.
  const joined = Mapped.join(
    parts.map((p) => p.body),
    '\n\n',
  );
  const all = joined.trim();
  const lead = joined.text.length - joined.text.trimStart().length;
  const blocks: DerivedBlock[] = [];
  let at = 0;
  for (const p of parts) {
    const start = Math.max(0, at - lead);
    const end = Math.min(all.text.length, at + p.body.text.length - lead);
    at += p.body.text.length + 2;
    if (end <= start) continue;
    blocks.push({
      kind: p.kind,
      ...(p.depth === undefined ? {} : { depth: p.depth }),
      text: all.text.slice(start, end),
      text_start: start,
      text_end: end,
      source_start: startOf(p.node),
      source_end: endOf(p.node),
    });
  }
  return { format: 'plain', text: all.text, blocks, map: [...all.segs] };
}

// ---- Markdown articles (公眾號) -------------------------------------------------

/** Article blocks: like the plain ones, but one block per list item. */
function articleBlocks(node: RootContent, source: string, depth = 0): PlainBlock[] {
  switch (node.type) {
    case 'list':
      return node.children.flatMap((item) =>
        item.children.flatMap((child): PlainBlock[] => {
          if (child.type === 'list') return articleBlocks(child, source, depth + 1);
          const body = inline(child, source).trim();
          return body.text === '' ? [] : [{ kind: 'item', depth, node: item, body }];
        }),
      );
    case 'blockquote':
      return node.children
        .flatMap((c) => articleBlocks(c, source, depth))
        .map((b) => ({ ...b, kind: b.kind === 'paragraph' ? 'quote' : b.kind }));
    default:
      return plainBlocks(node, source, depth);
  }
}

function deriveArticle(markdown: string, title: string | undefined): DerivedBody {
  const root = parse(markdown);
  // The original with front matter and a leading `# <title>` removed, otherwise unchanged.
  let cut = 0;
  for (const node of root.children) {
    if (isFrontMatter(node)) {
      cut = endOf(node);
      continue;
    }
    if (isTitleHeading(node, title)) cut = endOf(node);
    break;
  }
  const rest = markdown.slice(cut);
  const text = rest.trim();
  const base = cut + (rest.length - rest.trimStart().length);
  const kept = bodyNodes(root, title).filter((n) => startOf(n) >= cut);
  const blocks = kept
    .flatMap((n) => articleBlocks(n, markdown))
    .map((b): DerivedBlock => {
      const source_start = startOf(b.node);
      const source_end = endOf(b.node);
      return {
        kind: b.kind,
        ...(b.depth === undefined ? {} : { depth: b.depth }),
        text: b.body.text,
        text_start: Math.max(0, source_start - base),
        text_end: Math.min(text.length, Math.max(0, source_end - base)),
        source_start,
        source_end,
      };
    });
  const map: SourceMapSegment[] =
    text === ''
      ? []
      : [
          {
            text_start: 0,
            text_end: text.length,
            source_start: base,
            source_end: base + text.length,
          },
        ];
  return { format: 'markdown', text, blocks, map };
}

// ---- Plain-text sources (image and video works) ---------------------------------

function deriveText(source: string, format: 'markdown' | 'plain'): DerivedBody {
  const text = source.trim();
  const base = source.length - source.trimStart().length;
  const blocks: DerivedBlock[] = [];
  const re = /\S(?:[\s\S]*?\S)?(?=\s*\n\s*\n|\s*$)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    blocks.push({
      kind: 'paragraph',
      text: m[0],
      text_start: m.index,
      text_end: m.index + m[0].length,
      source_start: base + m.index,
      source_end: base + m.index + m[0].length,
    });
  }
  const map: SourceMapSegment[] =
    text === ''
      ? []
      : [
          {
            text_start: 0,
            text_end: text.length,
            source_start: base,
            source_end: base + text.length,
          },
        ];
  return { format, text, blocks, map };
}

// ---- Public API -----------------------------------------------------------------

/**
 * The body a platform shows for `source` (QC-084): plain text for 小紅書,
 * 抖音 and 視頻號 (paragraphs, `•`/`1.` list lines, link text; images, HTML
 * and front matter dropped), the Markdown itself for 公眾號 (front matter and
 * a leading title heading removed). Never truncates: limits are checked on
 * the result by `checkDerivedLimits`.
 */
export function deriveVariantBody(
  source: string,
  platform: Platform,
  options: DeriveOptions = {},
): DerivedBody {
  const format = PLATFORM_LIMITS[platform].bodyFormat;
  if (options.sourceFormat === 'text') return deriveText(source, format);
  return format === 'markdown'
    ? deriveArticle(source, options.title)
    : derivePlain(source, options.title);
}

/** What a work's platform body derives from: the description of image/video works, else the Markdown. */
export interface WorkBodySource {
  title: string;
  markdown: string;
  description?: string | null;
}

export function deriveWorkVariantBody(work: WorkBodySource, platform: Platform): DerivedBody {
  return work.description != null
    ? deriveVariantBody(work.description, platform, { sourceFormat: 'text' })
    : deriveVariantBody(work.markdown, platform, { title: work.title });
}

/** UTF-16 index of the `codePoint`-th code point of `text` (its length when past the end). */
export function codePointToIndex(text: string, codePoint: number): number {
  let index = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen === codePoint) return index;
    index += ch.length;
    seen += 1;
  }
  return text.length;
}

/**
 * Source position of a derived-text index (UTF-16). Text that came from no
 * source (separators, list markers) maps to the start of the next run, or
 * the end of the previous one at the end of the text; null when nothing maps.
 */
export function sourceOffsetAt(derived: DerivedBody, textIndex: number): number | null {
  let previous: SourceMapSegment | undefined;
  for (const s of derived.map) {
    if (textIndex < s.text_start) return s.source_start;
    if (textIndex < s.text_end) {
      return Math.min(s.source_start + (textIndex - s.text_start), s.source_end);
    }
    previous = s;
  }
  return previous === undefined ? null : previous.source_end;
}

/**
 * Derived-text position of a source offset (UTF-16), for following the editor
 * cursor in the preview. Offsets in dropped source (images, front matter)
 * map to the next derived run; null after the last one.
 */
export function textOffsetAt(derived: DerivedBody, sourceOffset: number): number | null {
  for (const s of derived.map) {
    if (sourceOffset < s.source_start) return s.text_start;
    if (sourceOffset <= s.source_end) {
      return Math.min(s.text_start + (sourceOffset - s.source_start), s.text_end);
    }
  }
  return null;
}

/** The block containing a source offset, or the next one after it. */
export function blockAtSource(derived: DerivedBody, sourceOffset: number): DerivedBlock | null {
  return derived.blocks.find((b) => sourceOffset < b.source_end) ?? null;
}

export interface DerivedVariantInput {
  title: string;
  body: DerivedBody;
  image_asset_ids: readonly string[];
  tags: readonly string[];
}

/**
 * `checkVariantLimits` on a derived body. `body_too_long` also says where the
 * platform cuts: `cut_at` (code points into the derived text, i.e. the limit)
 * and `source_offset` (UTF-16 into the source) so the editor can select the
 * place. Informational: nothing is truncated or blocked.
 */
export function checkDerivedLimits(
  platform: Platform,
  input: DerivedVariantInput,
  workType?: string,
): VariantWarning[] {
  const warnings = checkVariantLimits(
    platform,
    {
      title: input.title,
      body: input.body.text,
      image_asset_ids: input.image_asset_ids,
      tags: input.tags,
    },
    PLATFORM_LIMITS,
    workType,
  );
  return warnings.map((w) => {
    if (w.code !== 'body_too_long') return w;
    const cutAt = w.limit;
    return {
      ...w,
      cut_at: cutAt,
      source_offset: sourceOffsetAt(input.body, codePointToIndex(input.body.text, cutAt)),
    };
  });
}

/** Length of a derived body in the limits' unit (code points). */
export function derivedLength(derived: DerivedBody): number {
  return charCount(derived.text);
}
