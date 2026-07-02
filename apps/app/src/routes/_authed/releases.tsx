import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ReleasesPage } from '@/components/releases/releases-page';

export const Route = createFileRoute('/_authed/releases')({
  component: ReleasesRoute,
});

function ReleasesRoute(): React.JSX.Element {
  return <ReleasesPage />;
}
