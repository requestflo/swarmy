import { createFileRoute } from '@tanstack/react-router';
import { StatusPagesPage } from '@/components/statuspages/status-pages-page';

export const Route = createFileRoute('/_authed/status-pages')({
  component: StatusPagesPage,
});
