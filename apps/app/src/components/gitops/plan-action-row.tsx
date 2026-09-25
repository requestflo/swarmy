import * as React from 'react';
import { CircleAlertIcon, PlusIcon, XIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { ActionOutcomeView, Gate, PlanActionView } from './gitops-types';
import { ConfirmActionDialog } from './confirm-action-dialog';

const GATE: Record<Gate, { Icon: typeof PlusIcon; tone: string; label: string }> = {
  auto: { Icon: PlusIcon, tone: 'text-tone-ok', label: 'runs on its own' },
  confirm: { Icon: CircleAlertIcon, tone: 'text-tone-warn', label: 'needs a confirm' },
  blocked: { Icon: XIcon, tone: 'text-tone-bad', label: 'blocked' },
};

const OUTCOME: Record<ActionOutcomeView['status'], { tone: string; label: string }> = {
  done: { tone: 'text-tone-ok', label: 'Done' },
  held: { tone: 'text-tone-warn', label: 'Waiting for you' },
  failed: { tone: 'text-tone-bad', label: 'Failed' },
  skipped: { tone: 'text-status-idle', label: 'Skipped' },
};

interface PlanActionRowProps {
  planId: string;
  action: PlanActionView;
  outcome?: ActionOutcomeView;
  /** Held and still confirmable on this plan. */
  confirmable: boolean;
}

/** One step of a plan: gate icon, what it does, how it went — and Confirm when it's held. */
export function PlanActionRow({
  planId,
  action,
  outcome,
  confirmable,
}: PlanActionRowProps): React.JSX.Element {
  const gate = GATE[action.gate];
  const out = outcome ? OUTCOME[outcome.status] : null;
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <gate.Icon className={cn('mt-0.5 size-4 shrink-0', gate.tone)} aria-label={gate.label} />
      <div className="min-w-0 flex-1">
        <p className="text-sm">{action.reason}</p>
        <p className="text-muted-foreground mono-label truncate">{action.id}</p>
        {out ? (
          <p className={cn('mt-0.5 text-xs font-medium', out.tone)}>
            {out.label}
            {outcome?.message ? ` — ${outcome.message}` : ''}
          </p>
        ) : null}
      </div>
      {confirmable ? <ConfirmActionDialog planId={planId} action={action} /> : null}
    </li>
  );
}
