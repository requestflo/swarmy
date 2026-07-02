import { createFileRoute } from '@tanstack/react-router';
import { VectorPage } from '@/components/vector/vector-page';

export const Route = createFileRoute('/_authed/data_/vector')({
  component: VectorPage,
});
