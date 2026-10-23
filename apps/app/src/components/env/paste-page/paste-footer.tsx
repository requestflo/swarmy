import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useRestartPlan } from '@/components/app-tabs/variables/use-restart-plan';
import { useTRPC } from '@/integrations/trpc';
import type { EnvPasteState } from '../use-env-paste';

/** Apply as one deploy: one `services.update` rolls the whole paste out, with how the service restarts. */
export function PasteFooter({ st, stack, service }: { st: EnvPasteState; stack: string; service: { id: string; short: string } }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [done, setDone] = React.useState<string | null>(null);
  const target = React.useMemo(() => [{ id: service.id, name: service.short }], [service.id, service.short]);
  const plan = useRestartPlan(target);
  const line = plan?.lines[0];
  const moving = st.diff.rows.filter((r) => r.kind !== 'unchanged');
  const asSecrets = moving.filter((r) => r.kind !== 'removed' && st.masked.has(r.key)).length;
  const update = useMutation(
    trpc.services.update.mutationOptions({
      onSuccess: () => {
        setDone(`Applied · ${moving.length} ${moving.length === 1 ? 'variable' : 'variables'} changed, ${asSecrets} as secrets · ${service.short} is rolling out · on the audit log`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const apply = (): void =>
    update.mutate({
      id: service.id,
      env: Object.entries(st.diff.next).map(([key, value]) => ({ key, value, ...(st.masked.has(key) ? { secret: true } : {}) })),
    });

  return (
    <div className="calm-card flex flex-wrap items-center gap-3 px-5 py-3">
      {done ? (
        <span role="status" className="text-tone-ok flex items-center gap-2 text-[13px]">
          <CheckIcon className="size-4" /> {done}
        </span>
      ) : (
        <span className="text-muted-foreground text-[12.5px]">
          Secrets are masked everywhere in swarmy and still reach {service.short} as ordinary environment variables.
        </span>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="pointer-coarse:min-h-11">
          <Link to="/stacks/$name/config" params={{ name: stack }}>
            {done ? 'Back to Variables' : 'Cancel'}
          </Link>
        </Button>
        <Button disabled={!st.changed || update.isPending} onClick={apply} className="pointer-coarse:min-h-11">
          {update.isPending ? 'Applying…' : 'Apply as one deploy'}
        </Button>
      </span>
      <span className="text-muted-foreground w-full text-right font-mono text-[11px]">
        {line ? `${service.short} restarts ${line.words.replace(/^\d+ cop(y|ies) · /, '')}${line.seconds ? ` · ~${line.seconds} s` : ''} · ${line.copies} ${line.copies === 1 ? 'copy' : 'copies'}` : ' '}
      </span>
    </div>
  );
}
