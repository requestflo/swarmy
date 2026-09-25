import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { applySteps, choiceLabels, type HaChoice, type PgClusterFacts } from './pg-choices';

const COPY: Record<HaChoice, { title: string; body: string; button: string }> = {
  one: {
    title: 'Go back to one copy',
    body: 'The standby copy is removed. If the main server fails, the app is down until a restore finishes.',
    button: 'Remove the standby copy',
  },
  standby: {
    title: 'Add the standby copy',
    body: 'Copying the data to a second copy takes a few minutes. The app stays up the whole time.',
    button: 'Add standby copy',
  },
  auto: {
    title: 'Turn on switch-over',
    body: 'The standby copy moves to a different server if it has to. swarmy only switches over by itself once the copy has caught up.',
    button: 'Turn on switch-over',
  },
};

/**
 * The page's one coral action: move a database to the chosen "if a server
 * fails" shape. Applies the same `db.setReplicas` / `db.setTopology` calls the
 * Controls depth exposes (the reconcile worker converges the labels).
 */
export function PgNextAction({
  stack,
  cluster,
  choice,
}: {
  stack: string;
  cluster: PgClusterFacts;
  choice: HaChoice;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const topo = useMutation(trpc.db.setTopology.mutationOptions());
  const reps = useMutation(trpc.db.setReplicas.mutationOptions());
  const [busy, setBusy] = React.useState(false);
  const copy = COPY[choice];
  const labels = choiceLabels(choice, cluster);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      for (const step of applySteps(choice, cluster)) {
        if (step.kind === 'replicas') await reps.mutateAsync({ stack, cluster: cluster.name, replicas: step.replicas ?? 0 });
        else if (step.topology) await topo.mutateAsync({ stack, cluster: cluster.name, topology: step.topology });
      }
      toast.success(`${cluster.name}: ${copy.title.toLowerCase()} — swarmy is converging it now`);
      void qc.invalidateQueries();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <NextAction
      eyebrow={cluster.name}
      tone="info"
      title={copy.title}
      tech={Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(' · ')}
      actions={
        <Button onClick={() => void apply()} disabled={busy} className="min-h-11 sm:min-h-9">
          {busy ? 'Applying…' : copy.button}
        </Button>
      }
      hint={
        <Link to="/activity" className="hover:text-foreground underline-offset-2 hover:underline">
          Every change is in Activity
        </Link>
      }
    >
      {copy.body}
    </NextAction>
  );
}
