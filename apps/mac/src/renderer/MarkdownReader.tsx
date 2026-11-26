import { parseMarkdown } from '@qiu-creator/markdown-editor-web';
import { useMemo, type ReactNode } from 'react';
import { t } from './i18n.js';

/**
 * A Markdown asset laid out for reading (QC-108 方案 B): headings, paragraphs,
 * emphasis, quotes, lists, code, tables and rules, in a 680px column. It is
 * a reader, not the editor: links are text (nothing opens from here), images
 * show their alt text, raw HTML shows as text, and front matter is left out.
 * Everything is React text, so nothing in the file can run.
 */

type Root = ReturnType<typeof parseMarkdown>;
type Block = Root['children'][number];
type Parent = Extract<Block, { children: unknown }>;
type Child = Parent['children'][number];
type Node = Block | Child;

function hasChildren(node: Node): node is Node & { children: readonly Node[] } {
  return 'children' in node && Array.isArray(node.children);
}

function renderChildren(node: Node): ReactNode {
  return hasChildren(node) ? node.children.map((c, i) => renderNode(c, i)) : null;
}

function renderNode(node: Node, key: number): ReactNode {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(Math.max(node.depth, 1), 6);
      const Tag = `h${String(level)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag key={key}>{renderChildren(node)}</Tag>;
    }
    case 'paragraph':
      return <p key={key}>{renderChildren(node)}</p>;
    case 'text':
      return node.value;
    case 'strong':
      return <strong key={key}>{renderChildren(node)}</strong>;
    case 'emphasis':
      return <em key={key}>{renderChildren(node)}</em>;
    case 'delete':
      return <del key={key}>{renderChildren(node)}</del>;
    case 'inlineCode':
      return <code key={key}>{node.value}</code>;
    case 'break':
      return <br key={key} />;
    case 'link':
    case 'linkReference':
      return (
        <span
          key={key}
          className="md-read__link"
          title={node.type === 'link' ? node.url : undefined}
        >
          {renderChildren(node)}
        </span>
      );
    case 'image':
    case 'imageReference':
      return (
        <span key={key} className="md-read__img">
          {t('assets.mdImage', { alt: node.alt ?? '' })}
        </span>
      );
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node)}</blockquote>;
    case 'list':
      return node.ordered === true ? (
        <ol key={key} start={node.start ?? undefined}>
          {renderChildren(node)}
        </ol>
      ) : (
        <ul key={key}>{renderChildren(node)}</ul>
      );
    case 'listItem':
      return (
        <li key={key}>
          {node.checked === true || node.checked === false ? (
            <input type="checkbox" checked={node.checked} readOnly disabled />
          ) : null}
          {node.spread === true
            ? renderChildren(node)
            : node.children.map((c, i) =>
                c.type === 'paragraph' ? (
                  <span key={i}>{renderChildren(c)}</span>
                ) : (
                  renderNode(c, i)
                ),
              )}
        </li>
      );
    case 'code':
      return (
        <pre key={key}>
          <code>{node.value}</code>
        </pre>
      );
    case 'thematicBreak':
      return <hr key={key} />;
    case 'table':
      return (
        <table key={key}>
          <tbody>{renderChildren(node)}</tbody>
        </table>
      );
    case 'tableRow':
      return <tr key={key}>{renderChildren(node)}</tr>;
    case 'tableCell':
      return <td key={key}>{renderChildren(node)}</td>;
    case 'html':
      return (
        <code key={key} className="md-read__html">
          {node.value}
        </code>
      );
    case 'yaml':
    case 'definition':
    case 'footnoteDefinition':
      return null;
    default:
      return hasChildren(node) ? <span key={key}>{renderChildren(node)}</span> : null;
  }
}

export function MarkdownReader({ markdown }: { markdown: string }) {
  const tree = useMemo(() => parseMarkdown(markdown), [markdown]);
  return <article className="md-read">{tree.children.map((n, i) => renderNode(n, i))}</article>;
}
