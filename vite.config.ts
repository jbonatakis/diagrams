import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/oauth': { target: 'http://127.0.0.1:8787' },
      '/.well-known': { target: 'http://127.0.0.1:8787' },
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
      '/export': { target: 'http://127.0.0.1:8787' },
      '/mcp': { target: 'http://127.0.0.1:8787' },
      '/healthz': { target: 'http://127.0.0.1:8787' },
    },
  },
});
