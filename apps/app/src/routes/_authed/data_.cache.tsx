import { createFileRoute } from '@tanstack/react-router';
import { CachePage } from '@/components/cache/cache-page';

export const Route = createFileRoute('/_authed/data_/cache')({
  component: CachePage,
});
