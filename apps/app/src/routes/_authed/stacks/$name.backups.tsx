import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackBackups } from '@/components/backups/stack-backups';

/** Backups tab: DR setup & resilience for this stack. */
export const Route = createFileRoute('/_authed/stacks/$name/backups')({
  component: BackupsTab,
});

function BackupsTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return <StackBackups stack={name} />;
}
