import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor';
import { act, createRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createEditorPlugins, TO_MARKDOWN_OPTIONS } from '../src/plugins.js';

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await new Promise((r) => setTimeout(r, 0));
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Load Markdown into the real visual editor (same plugins as production) and export it again. */
export async function visualRoundTrip(
  markdown: string,
  edit?: (editor: MDXEditorMethods) => void,
): Promise<string> {
  const ref = createRef<MDXEditorMethods>();
  const errors: string[] = [];
  const m = await mount(
    <MDXEditor
      ref={ref}
      markdown={markdown}
      plugins={createEditorPlugins({ toolbar: false })}
      trim={false}
      toMarkdownOptions={TO_MARKDOWN_OPTIONS}
      onError={(e) => errors.push(e.error)}
    />,
  );
  try {
    const editor = ref.current;
    if (editor === null) throw new Error('editor did not mount');
    if (edit !== undefined) {
      await act(async () => {
        edit(editor);
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    if (errors.length > 0) throw new Error(`import errors: ${errors.join('; ')}`);
    return editor.getMarkdown();
  } finally {
    m.unmount();
  }
}
