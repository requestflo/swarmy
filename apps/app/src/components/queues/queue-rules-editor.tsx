import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueueView } from '@swarmy/core';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface Rules {
  scalePerJobs: number;
  minWorkers: number;
  maxWorkers: number;
  retries: number;
}

function rulesOf(q: QueueView): Rules {
  return {
    scalePerJobs: q.scalePerJobs,
    minWorkers: q.minWorkers,
    maxWorkers: q.maxWorkers,
    retries: q.retries,
  };
}

/** Scale-rule editor: jobs/worker slope, min/max workers, retry budget. */
export function QueueRulesEditor({ queue }: { queue: QueueView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [rules, setRules] = React.useState<Rules>(() => rulesOf(queue));
  const queueKey = `${queue.workerService}/${queue.name}`;
  React.useEffect(() => {
    setRules(rulesOf(queue));
    // Re-seed only when the SELECTED queue changes, not on every poll refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);

  const update = useMutation(
    trpc.queues.update.mutationOptions({
      onSuccess: () => {
        toast.success('Scale rules saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const dirty =
    rules.scalePerJobs !== queue.scalePerJobs ||
    rules.minWorkers !== queue.minWorkers ||
    rules.maxWorkers !== queue.maxWorkers ||
    rules.retries !== queue.retries;

  const save = (): void => {
    update.mutate({
      workerService: queue.workerService,
      name: queue.name,
      cacheCluster: queue.cacheCluster,
      convention: queue.convention,
      ...(queue.listKey ? { listKey: queue.listKey } : {}),
      ...rules,
      dlq: queue.dlq,
    });
  };

  const field = (
    label: string,
    key: keyof Rules,
    min: number,
  ): React.JSX.Element => (
    <div className="grid gap-1">
      <Label className="mono-label !text-[10px]">{label}</Label>
      <Input
        type="number"
        min={min}
        value={rules[key]}
        onChange={(e) => setRules({ ...rules, [key]: Math.max(min, Number(e.target.value) || 0) })}
      />
    </div>
  );

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">Scale rules</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {field('Jobs / worker', 'scalePerJobs', 1)}
        {field('Min', 'minWorkers', 0)}
        {field('Max', 'maxWorkers', 1)}
        {field('Retries', 'retries', 0)}
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-[11px]">
          Reconciler holds workers between {rules.minWorkers} and {rules.maxWorkers}, one per{' '}
          {rules.scalePerJobs} waiting jobs.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || rules.minWorkers > rules.maxWorkers || update.isPending}
          onClick={save}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}
