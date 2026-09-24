import * as React from 'react';
import { CircleAlertIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { heldActions, type AppEnvironment } from './gitops-types';
import { envLabel } from './plan-status';

interface AppNeedsYouProps {
  environments: AppEnvironment[];
  onOpen: (planId: string) => void;
}

/** "1 change needs you" — for the first environment holding a step for a human. */
export function AppNeedsYou({ environments, onOpen }: AppNeedsYouProps): React.JSX.Element | null {
  const env = environments.find((e) => e.latest?.status === 'needs-confirmation');
  const plan = env?.latest;
  if (!env || !plan) return null;
  const n = Math.max(1, heldActions(plan).length);
  return (
    <div className="bg-status-warning/10 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3">
      <CircleAlertIcon className="text-status-warning size-4 shrink-0" />
      <p className="min-w-0 flex-1 text-sm font-medium">
        {n} change{n === 1 ? '' : 's'} need{n === 1 ? 's' : ''} you on{' '}
        {envLabel(env.environment).toLowerCase()}.
      </p>
      <Button variant="outline" size="sm" onClick={() => onOpen(plan.id)}>
        Review
      </Button>
    </div>
  );
}
