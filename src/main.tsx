import './asset-path';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@excalidraw/excalidraw/index.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
