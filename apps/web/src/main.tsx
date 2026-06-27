import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/geist-mono';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
ReactDOM.createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
