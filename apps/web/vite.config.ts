import path from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { fumadocsMdx } from 'fumadocs-mdx/vite';

const ui = (p: string) => path.resolve(__dirname, '../../packages/ui/src', p);

/**
 * The marketing site + docs: TanStack Start, fully prerendered.
 *
 * Every page (marketing, blog, every docs page found by crawling links) is
 * rendered to static HTML at build time, and so are the search index
 * (/api/search), /sitemap.xml and /robots.txt. The output in dist/client is a
 * plain static site: the Dockerfile serves it with Caddy, so swarmy can host
 * its own site with no Node runtime.
 */
export default defineConfig({
  plugins: [
    // fumadocs-mdx resolves a second copy of vite 7.3.6 (it needs yaml ^2.9.1, a
    // vite peer), so its Plugin type is nominally distinct. Same version at runtime.
    fumadocsMdx() as unknown as PluginOption,
    tailwindcss(),
    tanstackStart({
      prerender: {
        enabled: true,
        crawlLinks: true,
        failOnError: true,
      },
      pages: [
        { path: '/api/search' },
        { path: '/sitemap.xml' },
        { path: '/robots.txt' },
        { path: '/schema/swarmy.v1.json' },
        { path: '/404' },
      ],
    }),
    // React's plugin must come after Start's.
    react(),
  ],
  resolve: {
    alias: [
      { find: '@swarmy/ui/styles.css', replacement: ui('styles.css') },
      { find: /^@swarmy\/ui$/, replacement: ui('index.ts') },
      { find: /^@swarmy\/ui\/(.*)$/, replacement: ui('$1') },
      { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, 'src/$1') },
    ],
  },
  server: { port: 4020, strictPort: true },
});
