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
      // Pure policy model (rule sentences, action catalogue, demo engine).
      { find: /^@swarmy\/abac\/model$/, replacement: pkg('abac/src/model.ts') },
      // Pure geo steering (region coordinates, great-circle km) — the DNS engine's own math.
      { find: /^@swarmy\/dns\/steer$/, replacement: pkg('dns/src/steer.ts') },
      // Pure swarmy.yaml parser, schema and toDesired — the Source tab editor validates with the controller's own code.
      { find: /^@swarmy\/app-config$/, replacement: pkg('app-config/src/index.ts') },
    ],
  },
  server: {
    port: 3023,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3021', changeOrigin: true },
      // Whole install surface (/install.sh, /install/loader.sh, /install/<v>/install.sh,
      // /install/bin/*) so a one-liner built from the dashboard origin works end
      // to end in dev. xfwd lets the controller see the address the node used.
      '/install': { target: 'http://localhost:3021', changeOrigin: true, xfwd: true },
      '/agent': { target: 'ws://localhost:3021', ws: true },
      // Browser terminal data plane (xterm → controller `/term/ws`). Same-origin
      // in prod; in dev the page is served from :3023, so proxy the WS upgrade to
      // the controller at :3021 (mirrors `/agent`). Without this the socket hits
      // the Vite dev origin and never reaches the API, so the shell never attaches.
      '/term': { target: 'ws://localhost:3021', ws: true },
      // Protect my app: the post-sign-in hop (/app-login → /_app-auth/start).
      '/_app-auth': { target: 'http://localhost:3021', changeOrigin: false },
    },
  },
});
