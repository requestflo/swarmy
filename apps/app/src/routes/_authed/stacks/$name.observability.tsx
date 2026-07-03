import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackObservabilityTab } from '@/components/observability/stack-observability-tab';

/** Observability tab: logs, metrics, traces, health & status page for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/observability')({
  component: ObservabilityTab,
});

function ObservabilityTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <StackObservabilityTab stack={name} />;
}
