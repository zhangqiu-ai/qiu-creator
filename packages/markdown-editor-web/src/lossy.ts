import type { Nodes, Root, Table } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';

/**
 * Syntax the visual editor may rewrite or drop on save. Documents that contain
 * any of these open in source mode so the original text is kept byte-for-byte
 * unless the user explicitly switches to the visual editor.
 */
export type LossyReason =
  'html' | 'footnote' | 'reference_link' | 'table_edge_case' | 'math' | 'directive' | 'parse_error';

export const LOSSY_REASON_LABELS: Readonly<Record<LossyReason, string>> = {
  html: 'HTML',
  footnote: '腳註',
  reference_link: '參照式連結',
  table_edge_case: '特殊表格',
  math: '數學公式',
  directive: '指令區塊',
  parse_error: '無法解析',
};

/** Parse Markdown with the same syntax extensions the editor understands. */
export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfm(), frontmatter(['yaml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])],
  });
}

function tableIsEdgeCase(table: Table, source: string): boolean {
  const width = table.children[0]?.children.length ?? 0;
  if (table.children.some((row) => row.children.length !== width)) return true;
  const start = table.position?.start.offset;
  const end = table.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const raw = source.slice(start, end);
  // Escaped pipes and multi-line cell content do not survive re-serialisation reliably.
  return raw.includes('\\|') || /<br\s*\/?>/i.test(raw);
}

export function detectLossySyntax(markdown: string): LossyReason[] {
  const found = new Set<LossyReason>();
  let tree: Root;
  try {
    tree = parseMarkdown(markdown);
  } catch {
    return ['parse_error'];
  }

  const visit = (node: Nodes): void => {
    switch (node.type) {
      case 'html':
        found.add('html');
        break;
      case 'footnoteDefinition':
      case 'footnoteReference':
        found.add('footnote');
        break;
      case 'definition':
      case 'linkReference':
      case 'imageReference':
        found.add('reference_link');
        break;
      case 'table':
        if (tableIsEdgeCase(node, markdown)) found.add('table_edge_case');
        break;
      default:
        break;
    }
    if ('children' in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(tree);

  if (/(^|\n)\s*\$\$/.test(markdown)) found.add('math');
  if (/(^|\n)\s*:{2,}[a-zA-Z]/.test(markdown)) found.add('directive');

  return [...found];
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
