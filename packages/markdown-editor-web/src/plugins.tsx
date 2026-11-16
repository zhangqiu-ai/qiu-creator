import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  InsertCodeBlock,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  frontmatterPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  type RealmPlugin,
} from '@mdxeditor/editor';

export const CODE_BLOCK_LANGUAGES: Readonly<Record<string, string>> = {
  '': '純文字',
  txt: '純文字',
  md: 'Markdown',
  js: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TSX',
  json: 'JSON',
  css: 'CSS',
  html: 'HTML',
  sh: 'Shell',
  bash: 'Bash',
  python: 'Python',
  yaml: 'YAML',
};

function Toolbar() {
  return (
    <>
      <UndoRedo />
      <Separator />
      <BlockTypeSelect />
      <BoldItalicUnderlineToggles />
      <CodeToggle />
      <Separator />
      <ListsToggle />
      <CreateLink />
      <InsertTable />
      <InsertCodeBlock />
      <InsertThematicBreak />
    </>
  );
}

export interface EditorPluginOptions {
  /** Include the formatting toolbar (off in headless tests). */
  toolbar?: boolean;
}

/**
 * The syntax set the visual editor supports. Kept in one place so the round-trip
 * tests exercise exactly what users get.
 */
export function createEditorPlugins(options: EditorPluginOptions = {}): RealmPlugin[] {
  const plugins: RealmPlugin[] = [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    imagePlugin(),
    // No column padding: editing one cell must not rewrite every row of the table.
    tablePlugin({ tablePipeAlign: false }),
    frontmatterPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
    codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
    markdownShortcutPlugin(),
  ];
  if (options.toolbar !== false) {
    plugins.push(toolbarPlugin({ toolbarContents: () => <Toolbar /> }));
  }
  return plugins;
}

/** Serialise with the most common Markdown spellings to keep diffs against the original small. */
export const TO_MARKDOWN_OPTIONS = {
  bullet: '-',
  rule: '-',
  emphasis: '*',
  strong: '*',
  fence: '`',
  listItemIndent: 'one',
} as const;
