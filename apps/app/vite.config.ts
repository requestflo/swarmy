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
    port: 3003,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/install.sh': { target: 'http://localhost:3001', changeOrigin: true },
      '/agent': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
