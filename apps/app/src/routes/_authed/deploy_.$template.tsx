import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ConfigurePage } from '@/components/deploy/configure-page';

/** Deploy → Configure (board 3): name, address and secrets for one template, then Deploy. */
export const Route = createFileRoute('/_authed/deploy_/$template')({
  component: ConfigureRoute,
});

function ConfigureRoute(): React.JSX.Element {
  const { template } = Route.useParams();
  return <ConfigurePage templateId={template} />;
}
