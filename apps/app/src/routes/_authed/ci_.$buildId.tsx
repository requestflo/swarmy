import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { BuildDetailPage } from '@/components/ci/build-detail-page';

export const Route = createFileRoute('/_authed/ci_/$buildId')({
  component: BuildDetailRoute,
});

function BuildDetailRoute(): React.JSX.Element {
  const { buildId } = Route.useParams();
  return <BuildDetailPage buildId={buildId} />;
}
