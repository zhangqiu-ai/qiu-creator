import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { Converter as toTraditional } from '#opencc/cn2t';
import { Converter as toSimplified } from '#opencc/t2cn';
import type { TextScript } from '@qiu-creator/contracts';

/**
 * Script conversion for text agents write into works (QC-103), with OpenCC.
 *
 * - zh-Hans: `tw → cn` (OpenCC `tw2s`): Taiwan variants and phrases to
 *   Simplified. Hong Kong text converts too, character by character.
 * - zh-Hant: `cn → tw` (OpenCC `s2tw`): characters and Taiwan variants only,
 *   no vocabulary changes (`软件` → `軟件`, not `軟體`), so the agent's words
 *   stay its own.
 *
 * Both directions leave text already in the target script as it is. OpenCC
 * only maps CJK characters; Latin text, digits and punctuation pass through.
 */

type Convert = (text: string) => string;

const converters = new Map<TextScript, Convert>();

function converter(script: TextScript): Convert {
  const cached = converters.get(script);
  if (cached !== undefined) return cached;
  const made: Convert =
    script === 'zh-Hans'
      ? toSimplified({ from: 'tw', to: 'cn' })
      : toTraditional({ from: 'cn', to: 'tw' });
  converters.set(script, made);
  return made;
}

/** Any CJK ideograph: text without one is never changed, so skip the dictionaries. */
const HAN = /\p{Script=Han}/u;

/** Plain text (titles, tags, image and video descriptions). */
export function convertPlain(text: string, script: TextScript): string {
  return HAN.test(text) ? converter(script)(text) : text;
}

/**
 * A Markdown document: only text people read is converted. Code blocks,
 * inline code, raw HTML, link and image URLs and titles, definitions,
 * autolinks and front-matter keys stay exactly as written, as do front-matter
 * values that look like a URL or a path. Parsed with the same
 * mdast/GFM/front-matter stack as the editor.
 */
export function convertMarkdown(markdown: string, script: TextScript): string {
  if (!HAN.test(markdown)) return markdown;
  const convert = converter(script);
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm(), frontmatter(['yaml', 'toml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])],
  });
  // Ranges of the source to convert, each with how to convert it.
  const edits: { start: number; end: number; apply: Convert }[] = [];
  const range = (node: Nodes): [number, number] | null => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start === undefined || end === undefined ? null : [start, end];
  };
  const walk = (node: Nodes, autolink: boolean): void => {
    // TOML front matter (`+++`) is parsed but not part of mdast's node types.
    const type: string = node.type;
    if (type === 'toml') {
      const r = range(node);
      if (r !== null) edits.push({ start: r[0], end: r[1], apply: frontMatter(convert) });
      return;
    }
    switch (node.type) {
      case 'text': {
        const r = range(node);
        if (r !== null && !autolink) edits.push({ start: r[0], end: r[1], apply: convert });
        return;
      }
      case 'image': {
        // Only the alt text, and only when it is written plainly (no escapes).
        const r = range(node);
        if (r === null || node.alt === null || node.alt === undefined || node.alt === '') return;
        const altStart = r[0] + 2;
        const altEnd = altStart + node.alt.length;
        if (markdown.startsWith('![', r[0]) && markdown.slice(altStart, altEnd) === node.alt) {
          edits.push({ start: altStart, end: altEnd, apply: convert });
        }
        return;
      }
      case 'yaml': {
        const r = range(node);
        if (r !== null) edits.push({ start: r[0], end: r[1], apply: frontMatter(convert) });
        return;
      }
      case 'code':
      case 'inlineCode':
      case 'html':
      case 'definition':
      case 'imageReference':
        return;
      default:
        break;
    }
    if ('children' in node) {
      // GFM literal autolinks (`https://…`, `www.…`) and `<https://…>`: their
      // text is the URL.
      const isAutolink =
        node.type === 'link' &&
        node.children.length === 1 &&
        node.children[0]?.type === 'text' &&
        node.url.endsWith(node.children[0].value);
      for (const child of node.children) walk(child, autolink || isAutolink);
    }
  };
  walk(tree, false);

  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const e of edits) {
    if (e.start < at) continue;
    out += markdown.slice(at, e.start) + e.apply(markdown.slice(e.start, e.end));
    at = e.end;
  }
  return out + markdown.slice(at);
}

/** `key: value` (YAML) or `key = value` (TOML), optionally a `- ` list item. */
const KEY_VALUE = /^(\s*(?:-\s+)?)("[^"]*"|'[^']*'|[^\s:="'#][^:=#]*?)(\s*[:=])(\s*)(.*)$/u;
/** A list item or continuation line with no key. */
const ITEM = /^(\s*(?:-\s+)?)(.*)$/u;

/** Values left alone: URLs, paths and file names (no spaces, with a scheme, `/` or an extension). */
function looksLikeLocation(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, '');
  if (v === '' || /\s/u.test(v)) return false;
  return /^[a-z][\w+.-]*:/iu.test(v) || v.includes('/') || /\.[a-z0-9]{1,5}$/iu.test(v);
}

/** Front matter: convert values line by line, never keys. */
function frontMatter(convert: Convert): Convert {
  const value = (v: string): string => (looksLikeLocation(v) ? v : convert(v));
  return (block) =>
    block
      .split('\n')
      .map((line) => {
        if (!HAN.test(line)) return line;
        const kv = KEY_VALUE.exec(line);
        if (kv !== null) {
          const [, lead = '', key = '', sep = '', gap = '', rest = ''] = kv;
          return lead + key + sep + gap + value(rest);
        }
        const item = ITEM.exec(line);
        const [, lead = '', rest = ''] = item ?? [];
        return lead + value(rest);
      })
      .join('\n');
}
