import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useRestartPlan } from '@/components/app-tabs/variables/use-restart-plan';
import { useTRPC } from '@/integrations/trpc';
import type { EnvPasteState } from '../use-env-paste';
import { envList, type PastePlan } from './paste-target';

/**
 * Apply as one deploy: one `services.update` per environment the paste
 * changes (each a rolling deploy of that copy), with how the service
 * restarts. Locked rows are already out of each plan's env.
 */
export function PasteFooter({
  st,
  plans,
  stack,
  short,
  blocked,
}: {
  st: EnvPasteState;
  plans: PastePlan[];
  stack: string;
  short: string;
  /** Which rows swarmy.yaml locks is unknown: apply nothing. */
  blocked: boolean;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [done, setDone] = React.useState<string | null>(null);
  const going = plans.filter((p) => p.moving > 0);
  const first = going[0] ?? plans[0];
  const target = React.useMemo(() => (first ? [{ id: first.serviceId, name: short }] : []), [first?.serviceId, short]);
  const restart = useRestartPlan(target);
  const line = restart?.lines[0];
  const update = useMutation(trpc.services.update.mutationOptions());
  const apply = async (): Promise<void> => {
    try {
      for (const p of going) {
        await update.mutateAsync({
          id: p.serviceId,
          env: Object.entries(p.next).map(([key, value]) => ({ key, value, ...(st.masked.has(key) ? { secret: true } : {}) })),
        });
      }
      const n = going.reduce((a, p) => a + p.moving, 0);
      setDone(`Applied to ${envList(going.map((p) => p.environment))} · ${n} ${n === 1 ? 'change' : 'changes'} · ${short} is rolling out · on the audit log`);
      void qc.invalidateQueries();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      void qc.invalidateQueries();
    }
  };
  const label = going.length > 1 ? `Apply to ${going.length} environments` : 'Apply as one deploy';

  return (
    <div className="calm-card flex flex-wrap items-center gap-3 px-5 py-3">
      {done ? (
        <span role="status" className="text-tone-ok flex items-center gap-2 text-[13px]">
          <CheckIcon className="size-4" /> {done}
        </span>
      ) : (
        <span className="text-muted-foreground text-[12.5px]">
          Secrets are masked everywhere in swarmy and still reach {short} as ordinary environment variables.
        </span>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="pointer-coarse:min-h-11">
          <Link to="/stacks/$name/config" params={{ name: stack }}>
            {done ? 'Back to Variables' : 'Cancel'}
          </Link>
        </Button>
        <Button disabled={blocked || going.length === 0 || update.isPending} onClick={() => void apply()} className="pointer-coarse:min-h-11">
          {update.isPending ? 'Applying…' : label}
        </Button>
      </span>
      <span className="text-muted-foreground w-full text-right font-mono text-[11px]">
        {!line
          ? ' '
          : going.length > 1
            ? `${short} restarts ${line.words.replace(/^\d+ cop(y|ies) · /, '')} in each environment, one environment after another`
            : `${short} restarts ${line.words.replace(/^\d+ cop(y|ies) · /, '')}${line.seconds ? ` · ~${line.seconds} s` : ''} · ${line.copies} ${line.copies === 1 ? 'copy' : 'copies'}`}
      </span>
    </div>
  );
}
