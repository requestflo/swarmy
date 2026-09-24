import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '@/components/not-found';

/**
 * A real /404 page, prerendered to 404/index.html. The static server
 * (apps/web/Caddyfile) serves it with a 404 status for unknown paths.
 */
export const Route = createFileRoute('/404')({
  head: () => ({ meta: [{ title: 'Not found · swarmy' }, { name: 'robots', content: 'noindex' }] }),
  component: NotFound,
});
