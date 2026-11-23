// Frozen copy of services/mac-server/src/variants/draft.ts before QC-084: the
// reference deriveVariantBody must reproduce, so migrated drafts compare equal.
import type { Nodes, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';

function parse(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfm(), frontmatter(['yaml', 'toml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])],
  });
}

/** Inline text of a node: images, HTML and footnote markers dropped, links keep their text. */
function inlineText(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value;
    case 'break':
      return '\n';
    case 'image':
    case 'imageReference':
    case 'html':
    case 'footnoteReference':
      return '';
    default:
      return 'children' in node ? node.children.map(inlineText).join('') : '';
  }
}

function blockText(node: RootContent, depth = 0): string[] {
  switch (node.type) {
    case 'heading':
    case 'paragraph': {
      const text = inlineText(node).trim();
      return text === '' ? [] : [text];
    }
    case 'list': {
      const lines: string[] = [];
      node.children.forEach((item, i) => {
        const marker = node.ordered === true ? `${String((node.start ?? 1) + i)}. ` : '• ';
        const indent = '  '.repeat(depth);
        const parts = item.children.flatMap((child) =>
          child.type === 'list' ? blockText(child, depth + 1) : [inlineText(child).trim()],
        );
        const [first = '', ...rest] = parts.filter((p) => p !== '');
        const check = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
        lines.push(`${indent}${marker}${check}${first}`, ...rest);
      });
      return [lines.join('\n')];
    }
    case 'blockquote':
      return node.children.flatMap((c) => blockText(c, depth));
    case 'code':
      return node.value.trim() === '' ? [] : [node.value];
    case 'table':
      return [
        node.children
          .map((row) => row.children.map((cell) => inlineText(cell).trim()).join(' | '))
          .join('\n'),
      ];
    // Front matter, HTML, rules, definitions and footnote definitions are not post text.
    default:
      return [];
  }
}

/** Front matter nodes (`toml` has no mdast typing, hence the string check). */
const FRONT_MATTER: readonly string[] = ['yaml', 'toml'];
const isFrontMatter = (node: RootContent): boolean => FRONT_MATTER.includes(node.type);

function isTitleHeading(node: RootContent | undefined, title: string): boolean {
  return node?.type === 'heading' && node.depth === 1 && inlineText(node).trim() === title.trim();
}

/**
 * Plain-text body for platforms that do not render Markdown (小紅書, 抖音,
 * 視頻號): one block per paragraph/heading, lists as `•`/`1.` lines, links as
 * their text, images and HTML dropped. A leading `# <title>` is dropped
 * because the title is its own field.
 */
export function markdownToPlainText(markdown: string, title: string): string {
  const children = parse(markdown).children.filter((n) => !isFrontMatter(n));
  const body = isTitleHeading(children[0], title) ? children.slice(1) : children;
  return body
    .flatMap((n) => blockText(n))
    .join('\n\n')
    .trim();
}

/**
 * Markdown body for articles (公眾號): the original with front matter and a
 * leading `# <title>` removed, otherwise unchanged.
 */
export function markdownForArticle(markdown: string, title: string): string {
  const children = parse(markdown).children;
  let cut = 0;
  for (const node of children) {
    if (isFrontMatter(node)) {
      cut = node.position?.end.offset ?? cut;
      continue;
    }
    if (isTitleHeading(node, title)) cut = node.position?.end.offset ?? cut;
    break;
  }
  return markdown.slice(cut).trim();
}
