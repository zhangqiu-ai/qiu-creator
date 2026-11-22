import {
  addExportVisitor$,
  addImportVisitor$,
  addLexicalNode$,
  realmPlugin,
} from '@mdxeditor/editor';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { mergeRegister } from '@lexical/utils';
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { useEffect, useState, type ReactNode } from 'react';
import { RAW_ELEMENT_NAME } from './raw.js';

/**
 * Read-only stand-in for syntax the visual editor cannot edit (see raw.ts).
 * It keeps the original text, shows it (an <img> as the picture, anything else
 * as the text it is), can be selected and deleted, and is written out as its
 * placeholder tag so the original comes back byte-for-byte.
 */
type SerializedRawNode = Spread<
  { index: number; source: string; inline: boolean },
  SerializedLexicalNode
>;

export class RawSyntaxNode extends DecoratorNode<ReactNode> {
  __index: number;
  __source: string;
  __inline: boolean;
  /** Maps an image `src` to a loadable URL; display only, never serialised. */
  __resolve: ((src: string) => Promise<string>) | null;

  static override getType(): string {
    return 'qc-raw-syntax';
  }
  static override clone(node: RawSyntaxNode): RawSyntaxNode {
    return new RawSyntaxNode(
      node.__index,
      node.__source,
      node.__inline,
      node.__resolve,
      node.__key,
    );
  }
  static override importJSON(s: SerializedRawNode): RawSyntaxNode {
    return new RawSyntaxNode(s.index, s.source, s.inline, null);
  }
  constructor(
    index: number,
    source: string,
    inline: boolean,
    resolve: ((src: string) => Promise<string>) | null,
    key?: NodeKey,
  ) {
    super(key);
    this.__resolve = resolve;
    this.__index = index;
    this.__source = source;
    this.__inline = inline;
  }
  override exportJSON(): SerializedRawNode {
    return {
      type: 'qc-raw-syntax',
      version: 1,
      index: this.__index,
      source: this.__source,
      inline: this.__inline,
    };
  }
  override createDOM(): HTMLElement {
    const el = document.createElement(this.__inline ? 'span' : 'div');
    el.className = this.__inline ? 'qc-raw qc-raw--inline' : 'qc-raw qc-raw--block';
    return el;
  }
  override updateDOM(): boolean {
    return false;
  }
  override isInline(): boolean {
    return this.__inline;
  }
  override isKeyboardSelectable(): boolean {
    return true;
  }
  override getTextContent(): string {
    return this.__source;
  }
  override decorate(): ReactNode {
    return (
      <RawSyntaxView
        nodeKey={this.__key}
        source={this.__source}
        inline={this.__inline}
        resolveImage={this.__resolve}
      />
    );
  }
}

export function $isRawSyntaxNode(node: LexicalNode | null | undefined): node is RawSyntaxNode {
  return node instanceof RawSyntaxNode;
}

/** `<img ...>` alone: the attributes to show it with, or null for any other text. */
export function imageOf(source: string): {
  src: string;
  alt: string;
  width: number | undefined;
  height: number | undefined;
} | null {
  if (!/^\s*<img\b[^>]*>\s*$/i.test(source)) return null;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = source;
  const img = wrapper.querySelector('img');
  const src = img?.getAttribute('src');
  if (img === null || src === null || src === undefined) return null;
  const size = (name: string): number | undefined => {
    const n = Number.parseInt(img.getAttribute(name) ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return { src, alt: img.getAttribute('alt') ?? '', width: size('width'), height: size('height') };
}

function RawSyntaxView(props: {
  nodeKey: NodeKey;
  source: string;
  inline: boolean;
  resolveImage: ((src: string) => Promise<string>) | null;
}) {
  const { nodeKey, source, inline, resolveImage } = props;
  const [editor] = useLexicalComposerContext();
  const [selected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const image = imageOf(source);
  const imageSrc = image?.src ?? null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (imageSrc === null) return;
    let live = true;
    void (resolveImage === null ? Promise.resolve(imageSrc) : resolveImage(imageSrc)).then(
      (u) => {
        if (live) setUrl(u);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [imageSrc, resolveImage]);

  useEffect(() => {
    const onDelete = (event: KeyboardEvent): boolean => {
      if (!selected || !$isNodeSelection($getSelection())) return false;
      event.preventDefault();
      const node = $getNodeByKey(nodeKey);
      if ($isRawSyntaxNode(node)) node.remove();
      return true;
    };
    return mergeRegister(
      editor.registerCommand(KEY_DELETE_COMMAND, onDelete, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_BACKSPACE_COMMAND, onDelete, COMMAND_PRIORITY_LOW),
    );
  }, [editor, nodeKey, selected]);

  const select = (event: React.MouseEvent) => {
    event.stopPropagation();
    clearSelection();
    setSelected(true);
  };
  const cls = `qc-raw__body${selected ? ' qc-raw__body--selected' : ''}`;
  if (image !== null) {
    return (
      <span className={cls} onClick={select} data-raw-kind="image">
        {url === null ? (
          <span className="qc-raw__text">{source}</span>
        ) : (
          <img
            src={url}
            alt={image.alt}
            {...(image.width === undefined ? {} : { width: image.width })}
            {...(image.height === undefined ? {} : { height: image.height })}
            draggable={false}
          />
        )}
      </span>
    );
  }
  const Tag = inline ? 'span' : 'pre';
  return (
    <Tag className={`${cls} qc-raw__text`} onClick={select} data-raw-kind="text">
      {source}
    </Tag>
  );
}

/** mdast placeholder element: `<qc-raw n="3" />`, block or inline. */
interface MdastPlaceholder {
  type: 'mdxJsxFlowElement' | 'mdxJsxTextElement';
  name: string;
  attributes: { type: string; name: string; value?: unknown }[];
}
const isPlaceholder = (node: { type: string }): node is MdastPlaceholder =>
  (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
  (node as { name?: unknown }).name === RAW_ELEMENT_NAME;
const indexOf = (node: MdastPlaceholder): number =>
  Number(node.attributes.find((a) => a.name === 'n')?.value ?? -1);

export interface RawSyntaxOptions {
  /** The originals the placeholders stand for; read when the document is imported. */
  originals: { current: readonly string[] };
  resolveImage?: (src: string) => Promise<string>;
}

export const rawSyntaxPlugin = realmPlugin<RawSyntaxOptions>({
  init(realm, params) {
    realm.pubIn({
      [addLexicalNode$]: RawSyntaxNode,
      [addImportVisitor$]: {
        priority: 100,
        testNode: (node: { type: string }) => isPlaceholder(node),
        visitNode({
          mdastNode,
          actions,
        }: {
          mdastNode: MdastPlaceholder;
          actions: { addAndStepInto: (n: LexicalNode) => void };
        }) {
          const index = indexOf(mdastNode);
          const source = params?.originals.current[index] ?? '';
          actions.addAndStepInto(
            new RawSyntaxNode(
              index,
              source,
              mdastNode.type === 'mdxJsxTextElement',
              params?.resolveImage ?? null,
            ),
          );
        },
      },
      [addExportVisitor$]: {
        priority: 100,
        testLexicalNode: $isRawSyntaxNode,
        visitLexicalNode({
          lexicalNode,
          mdastParent,
          actions,
        }: {
          lexicalNode: RawSyntaxNode;
          mdastParent: unknown;
          actions: { appendToParent: (parent: unknown, node: unknown) => void };
        }) {
          actions.appendToParent(mdastParent, {
            type: lexicalNode.__inline ? 'mdxJsxTextElement' : 'mdxJsxFlowElement',
            name: RAW_ELEMENT_NAME,
            attributes: [
              { type: 'mdxJsxAttribute', name: 'n', value: String(lexicalNode.__index) },
            ],
            children: [],
          });
        },
      },
    });
  },
});
