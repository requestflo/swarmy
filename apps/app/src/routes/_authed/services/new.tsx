import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { NewServicePage } from '@/components/deploy/new-service-page';

export const Route = createFileRoute('/_authed/services/new')({
  /** `?stack=<app>` preselects which app the service joins ("Add a service" in an app). */
  validateSearch: (search: Record<string, unknown>): { stack?: string } =>
    typeof search.stack === 'string' && search.stack ? { stack: search.stack } : {},
  component: NewServiceRoute,
});

function NewServiceRoute(): React.JSX.Element {
  const { stack } = Route.useSearch();
  return <NewServicePage stack={stack} />;
}
