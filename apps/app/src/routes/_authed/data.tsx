import { createFileRoute } from '@tanstack/react-router';
import { DataPage } from '@/components/data/data-page';

export const Route = createFileRoute('/_authed/data')({
  component: DataPage,
});
