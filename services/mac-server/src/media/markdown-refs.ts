import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';

const IMG_SRC =
  /<(?:img|video|audio|source)\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/**
 * Media references in a Markdown document, in document order and without
 * duplicates: `![alt](src)`, reference-style `![alt][id]` images, and `src`
 * attributes of `<img>`/`<video>`/`<audio>`/`<source>` in raw HTML. Parsed
 * with the same mdast/GFM/front-matter stack as the editor, so code blocks
 * and front matter are never mistaken for images.
 */
export function extractMediaRefs(markdown: string): string[] {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm(), frontmatter(['yaml', 'toml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])],
  });
  const definitions = new Map<string, string>();
  const refs: string[] = [];
  const walk = (node: Nodes): void => {
    switch (node.type) {
      case 'image':
        refs.push(node.url);
        break;
      case 'imageReference':
        // Resolved after the walk: definitions may come later in the document.
        refs.push(`\0ref:${node.identifier}`);
        break;
      case 'definition':
        definitions.set(node.identifier, node.url);
        break;
      case 'html':
        for (const m of node.value.matchAll(IMG_SRC)) {
          const value = m[1] ?? m[2] ?? m[3];
          if (value !== undefined) refs.push(decodeHtmlEntities(value));
        }
        break;
      default:
        break;
    }
    if ('children' in node) {
      for (const child of node.children) walk(child);
    }
  };
  walk(tree);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of refs) {
    const src = raw.startsWith('\0ref:') ? definitions.get(raw.slice(5)) : raw;
    if (src === undefined) continue;
    const trimmed = src.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return NAMED[entity.toLowerCase()] ?? whole;
  });
}

export type RefClass =
  { type: 'inline' } | { type: 'remote' } | { type: 'rejected' } | { type: 'local'; path: string };

/**
 * Classify one reference. Local references are percent-decoded, stripped of
 * `?query`/`#fragment`, and returned `/`-separated (not yet joined to a base).
 */
export function classifyRef(src: string): RefClass {
  if (/^data:/i.test(src)) return { type: 'inline' };
  if (/^https?:\/\//i.test(src) || src.startsWith('//')) return { type: 'remote' };
  // Any other scheme (file:, javascript:, app-specific…) is never resolved.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return { type: 'rejected' };
  const bare = src.replace(/[?#].*$/, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return { type: 'rejected' };
  }
  if (decoded === '') return { type: 'rejected' };
  return { type: 'local', path: decoded };
}
