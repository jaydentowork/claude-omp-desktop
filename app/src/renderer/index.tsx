import { createRoot } from 'react-dom/client';
import { App } from './app';
import { OmpProvider } from './omp-provider';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing from index.html');
createRoot(rootEl).render(
  <OmpProvider>
    <App />
  </OmpProvider>,
);
