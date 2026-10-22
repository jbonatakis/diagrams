import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('public/fonts', { recursive: true });
cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'public/fonts', { recursive: true });
