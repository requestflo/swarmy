import { createFileRoute } from '@tanstack/react-router';
import { CostPage } from '@/components/cost/cost-page';

export const Route = createFileRoute('/_authed/cost')({
  component: CostPage,
});
