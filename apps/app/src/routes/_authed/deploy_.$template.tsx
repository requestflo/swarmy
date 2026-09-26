import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ConfigurePage } from '@/components/deploy/configure-page';

/** Deploy → Configure (board 3): name, address and secrets for one template, then Deploy. `?name=` prefills the name (⌘K "deploy ghost as blog" → Edit details). */
export const Route = createFileRoute('/_authed/deploy_/$template')({
  validateSearch: (search: Record<string, unknown>): { name?: string } =>
    typeof search.name === 'string' && search.name ? { name: search.name.slice(0, 30) } : {},
  component: ConfigureRoute,
});

function ConfigureRoute(): React.JSX.Element {
  const { template } = Route.useParams();
  const { name } = Route.useSearch();
  return <ConfigurePage templateId={template} name={name} />;
}
