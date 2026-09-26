import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { VariablesTab } from '@/components/app-tabs/variables/variables-tab';

/**
 * Variables & secrets tab: every setting the app runs with — plain variables,
 * write-only secrets (versioned Docker secrets, one-click rotation) and, from
 * Controls up, config files. Code depth shows the swarmy.yaml env block and CLI.
 */
export const Route = createFileRoute('/_authed/stacks/$name/config/')({
  component: ConfigTab,
});

function ConfigTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <VariablesTab stack={name} />;
}
