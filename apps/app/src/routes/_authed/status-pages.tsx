import { createFileRoute } from '@tanstack/react-router';
import { StatusPagesPage } from '@/components/statuspages/status-pages-page';

export interface StatusPagesSearch {
  /** The incident "Post an update" goes to (defaults to the newest open one). */
  incident?: string;
  /** Which status page, when there are several (slug). */
  page?: string;
}

export const Route = createFileRoute('/_authed/status-pages')({
  validateSearch: (search: Record<string, unknown>): StatusPagesSearch => ({
    ...(typeof search.incident === 'string' && search.incident ? { incident: search.incident } : {}),
    ...(typeof search.page === 'string' && search.page ? { page: search.page } : {}),
  }),
  component: StatusPagesPage,
});
