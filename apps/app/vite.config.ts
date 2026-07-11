import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';

const pkg = (p: string) => path.resolve(__dirname, '../../packages', p);

export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: '@swarmy/ui/styles.css', replacement: pkg('ui/src/styles.css') },
      { find: /^@swarmy\/ui$/, replacement: pkg('ui/src/index.ts') },
      { find: /^@swarmy\/ui\/(.*)$/, replacement: pkg('ui/src/$1') },
      { find: /^@swarmy\/core$/, replacement: pkg('core/src/index.ts') },
      { find: /^@swarmy\/core\/(.*)$/, replacement: pkg('core/src/$1') },
      { find: /^@swarmy\/auth\/client$/, replacement: pkg('auth/src/client.ts') },
    ],
  },
  server: {
    port: 3023,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3021', changeOrigin: true },
      '/install.sh': { target: 'http://localhost:3021', changeOrigin: true },
      '/agent': { target: 'ws://localhost:3021', ws: true },
      // Browser terminal data plane (xterm → controller `/term/ws`). Same-origin
      // in prod; in dev the page is served from :3023, so proxy the WS upgrade to
      // the controller at :3021 (mirrors `/agent`). Without this the socket hits
      // the Vite dev origin and never reaches the API, so the shell never attaches.
      '/term': { target: 'ws://localhost:3021', ws: true },
    },
  },
});
