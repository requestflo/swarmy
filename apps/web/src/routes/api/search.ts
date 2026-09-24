import { createFileRoute } from '@tanstack/react-router';
import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

/**
 * The docs search index. `staticGET` exports the whole Orama index as JSON;
 * it is prerendered to dist/client/api/search at build time and the search
 * dialog queries it in the browser (`type: 'static'` in __root.tsx), so search
 * needs no server at runtime.
 */
const server = createFromSource(source, { language: 'english' });

export const Route = createFileRoute('/api/search')({
  server: {
    handlers: {
      GET: async () => server.staticGET(),
    },
  },
});
