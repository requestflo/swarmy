import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '@/components/activity/activity-page';
import { STREAM_FILTERS, type StreamFilter } from '@/components/activity/activity-items';

export interface ActivitySearch {
  /** Stream filter chip (All when absent). */
  filter?: Exclude<StreamFilter, 'all'>;
  /** The incident open in the room beside the stream. */
  incident?: string;
}

export const Route = createFileRoute('/_authed/activity')({
  validateSearch: (search: Record<string, unknown>): ActivitySearch => ({
    ...(typeof search.filter === 'string' && search.filter !== 'all' && (STREAM_FILTERS as readonly string[]).includes(search.filter)
      ? { filter: search.filter as ActivitySearch['filter'] }
      : {}),
    ...(typeof search.incident === 'string' && search.incident ? { incident: search.incident } : {}),
  }),
  component: ActivityPage,
});
