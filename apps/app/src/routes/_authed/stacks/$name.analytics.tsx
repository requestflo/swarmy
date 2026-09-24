import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AnalyticsPage } from '@/components/rum/analytics-page';

/** Observability → Analytics: web analytics counted at the edge for this app. */
export const Route = createFileRoute('/_authed/stacks/$name/analytics')({
  component: AnalyticsRoute,
});

function AnalyticsRoute(): React.JSX.Element {
  const { name } = Route.useParams();
  return <AnalyticsPage stack={name} />;
}
