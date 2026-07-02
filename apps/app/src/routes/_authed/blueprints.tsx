import { createFileRoute } from '@tanstack/react-router';
import { BlueprintsPage } from '@/components/blueprints/blueprints-page';

export const Route = createFileRoute('/_authed/blueprints')({
  component: BlueprintsPage,
});
