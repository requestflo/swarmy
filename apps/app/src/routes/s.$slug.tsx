import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PublicStatusPage } from '@/components/statuspages/public-status-page';

export const Route = createFileRoute('/s/$slug')({
  component: PublicStatusRoute,
});

/**
 * Public status page — deliberately OUTSIDE the `_authed` layout: anyone with
 * the link can view it, no session required. Fetches the unauthenticated
 * `GET /status/<slug>.json` snapshot (demo mode resolves the same shape via
 * the in-memory store) and renders components, uptime bars and incidents.
 */
function PublicStatusRoute(): React.JSX.Element {
  const { slug } = Route.useParams();
  return <PublicStatusPage slug={slug} />;
}
