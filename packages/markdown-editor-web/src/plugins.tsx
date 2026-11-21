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
  realmPlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  translation$,
  type RealmPlugin,
} from '@mdxeditor/editor';
import { SOURCE_LOCALE, translate, type Locale } from '@qiu-creator/i18n';

/** Code-block languages the editor offers; 純文字 is the only interface text (QC-042). */
export function codeBlockLanguages(
  locale: Locale = SOURCE_LOCALE,
): Readonly<Record<string, string>> {
  const plain = translate(locale, 'editor.plainText');
  return { '': plain, txt: plain, ...LANGUAGE_NAMES };
}

/** Language names, which are proper names and the same in every language. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
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

/**
 * MDXEditor reads its `translation` prop only when it is created; its own
 * plugins re-apply their options on every render through `update`. This one
 * does the same for the translation, so switching the interface language
 * relabels the toolbar, dialogs, tooltips and placeholders of an editor that
 * stays open (QC-047: tabs keep editors mounted), with no remount: the
 * document, caret, undo history and scroll stay as they are.
 */
export const liveTranslationPlugin = realmPlugin<{
  translation: (
    key: string,
    defaultValue: string,
    interpolations?: Record<string, unknown>,
  ) => string;
}>({
  update(realm, params) {
    if (params !== undefined) realm.pub(translation$, params.translation);
  },
});

export interface EditorPluginOptions {
  /** Include the formatting toolbar (off in headless tests). */
  toolbar?: boolean;
  /** Interface language for the parts the plugins name themselves. */
  locale?: Locale;
  /**
   * Map an image `src` as written in the Markdown to a URL the view can load.
   * Display only: the Markdown keeps the original `src`.
   */
  resolveImage?: (src: string) => Promise<string>;
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
    imagePlugin(
      options.resolveImage === undefined ? {} : { imagePreviewHandler: options.resolveImage },
    ),
    // No column padding: editing one cell must not rewrite every row of the table.
    tablePlugin({ tablePipeAlign: false }),
    frontmatterPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
    codeMirrorPlugin({ codeBlockLanguages: codeBlockLanguages(options.locale) }),
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
