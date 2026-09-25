import { createFileRoute } from '@tanstack/react-router';
import { FrontDoorPage } from '@/components/ingress/front-door-page';

/** "Front door" (was Edge & ingress): fleet-wide edge config, not per-route detail. */
export const Route = createFileRoute('/_authed/ingress')({
  component: FrontDoorPage,
});
