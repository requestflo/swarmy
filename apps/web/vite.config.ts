import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const ui = (p: string) => path.resolve(__dirname, '../../packages/ui/src', p);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@swarmy/ui/styles.css', replacement: ui('styles.css') },
      { find: /^@swarmy\/ui$/, replacement: ui('index.ts') },
      { find: /^@swarmy\/ui\/(.*)$/, replacement: ui('$1') },
    ],
  },
  server: { port: 4000, strictPort: true },
});
