import { createFileRoute } from '@tanstack/react-router';
import { SearchPage } from '@/components/searchsvc/search-page';

export const Route = createFileRoute('/_authed/data_/search')({
  component: SearchPage,
});
