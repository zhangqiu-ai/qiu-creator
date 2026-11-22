import type { Root, Table } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';

/** Parse Markdown with the same syntax extensions the editor understands. */
export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfm(), frontmatter(['yaml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])],
  });
}

export function tableIsEdgeCase(table: Table, source: string): boolean {
  const width = table.children[0]?.children.length ?? 0;
  if (table.children.some((row) => row.children.length !== width)) return true;
  const start = table.position?.start.offset;
  const end = table.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const raw = source.slice(start, end);
  // Escaped pipes and multi-line cell content do not survive re-serialisation reliably.
  return raw.includes('\\|') || /<br\s*\/?>/i.test(raw);
}

type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

/**
 * Structural fingerprint of a Markdown document: the mdast tree without
 * positions or serialisation-only details. Two documents with the same
 * fingerprint have the same headings, lists, tables, code, links and images.
 */
export function markdownStructure(markdown: string): Plain {
  const strip = (value: unknown): Plain => {
    if (Array.isArray(value)) return value.map(strip);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, Plain> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        // `spread` (tight vs loose lists) and `position` are formatting details.
        if (key === 'position' || key === 'spread' || v === undefined) continue;
        out[key] = strip(v);
      }
      return out;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    return null;
  };
  return strip(parseMarkdown(markdown));
}

/**
 * The visual editor drops the file's final newline. Restore it when the loaded
 * text ended with one so saving an edit does not also rewrite the file ending.
 */
export function restoreFinalNewline(exported: string, loaded: string): string {
  if (loaded.endsWith('\n') && !exported.endsWith('\n')) return `${exported}\n`;
  return exported;
}
