import { buildCssVariables } from '@qiu-creator/design-tokens';
import '@qiu-creator/markdown-editor-web/style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const tokens = document.createElement('style');
tokens.textContent = buildCssVariables();
document.head.prepend(tokens);

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('#root missing');
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
