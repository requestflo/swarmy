import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { StackConfigsSection } from '@/components/configsmgr/stack-configs-section';
import { StackSecretsSection } from '@/components/secretsmgr/stack-secrets-section';

/**
 * Config tab: this stack's secrets & configs — versioned Docker secrets with
 * one-click rotation and readable, diffable Docker configs with apply/rollback.
 * Everything inline: expanding create cards, row-expands, AlertDialog confirms.
 */
export const Route = createFileRoute('/_authed/stacks/$name/config')({
  component: ConfigTab,
});

function ConfigTab(): React.JSX.Element {
  const { name } = Route.useParams();
  return (
    <div className="space-y-10 pb-8">
      <StackSecretsSection stack={name} />
      <StackConfigsSection stack={name} />
    </div>
  );
}
