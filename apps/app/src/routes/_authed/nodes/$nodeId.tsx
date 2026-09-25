import * as React from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { ServerDetailPage } from '@/components/nodes/server-detail/server-detail-page';

/** One server: sentence, next action, what runs here, and every knob at Controls (components/nodes/server-detail). */
export const Route = createFileRoute('/_authed/nodes/$nodeId')({
  component: NodeDetailRoute,
});

function NodeDetailRoute(): React.JSX.Element {
  const { nodeId } = useParams({ from: '/_authed/nodes/$nodeId' });
  return <ServerDetailPage nodeId={nodeId} />;
}
