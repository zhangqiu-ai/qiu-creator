// Inter is bundled into the app by Vite; nothing is fetched from the network.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter/wght-italic.css';
import { buildCssVariables } from '@qiu-creator/design-tokens';
import '@qiu-creator/markdown-editor-web/style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { restoreTheme } from './theme.js';
import './styles.css';

const tokens = document.createElement('style');
tokens.textContent = buildCssVariables();
document.head.prepend(tokens);

// The main process already applied the saved 外觀; pin it for the tokens too (QC-038).
void restoreTheme();

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('#root missing');
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
