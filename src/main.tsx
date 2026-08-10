import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadRuntimeConfig } from './runtimeConfig';
import './styles.css';

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('APPLICATION_ROOT_MISSING: the required #root element was not found');
const runtimeConfig = loadRuntimeConfig();
root.dataset['buildRef'] = runtimeConfig.buildRef;
root.dataset['runtimeSurface'] = runtimeConfig.surface;

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
