import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** "mgr-1, wkr-1 and wkr-2". */
export function names(nodes: Pick<NodeSummary, 'name'>[]): string {
  const n = nodes.map((x) => x.name);
  return n.length < 2 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
}

/** Run one call per server; say what worked and quote what didn't. */
async function each(nodes: NodeSummary[], call: (id: string) => Promise<unknown>, said: (ok: NodeSummary[]) => string): Promise<void> {
  const res = await Promise.allSettled(nodes.map((n) => call(n.id)));
  const ok = nodes.filter((_, i) => res[i]!.status === 'fulfilled');
  if (ok.length) toast.success(said(ok));
  res.forEach((r, i) => {
    if (r.status === 'rejected') toast.error(`${nodes[i]!.name}: ${(r.reason as Error).message}`);
  });
}

/**
 * The multi-select bar's three calls, one per picked server: `nodes.drain`,
 * `nodes.setLabels` (merges the one label in) and `nodes.upgradeAgent`.
 */
export function useBulkActions(): {
  drain: (nodes: NodeSummary[]) => Promise<void>;
  label: (nodes: NodeSummary[], key: string, value: string) => Promise<void>;
  upgrade: (nodes: NodeSummary[]) => Promise<void>;
  busy: boolean;
} {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const drainM = useMutation(trpc.nodes.drain.mutationOptions());
  const labelM = useMutation(trpc.nodes.setLabels.mutationOptions());
  const upgradeM = useMutation(trpc.nodes.upgradeAgent.mutationOptions());
  const [busy, setBusy] = React.useState(false);

  const wrap = React.useCallback(
    async (job: () => Promise<void>) => {
      setBusy(true);
      try {
        await job();
      } finally {
        setBusy(false);
        void qc.invalidateQueries();
      }
    },
    [qc],
  );

  return {
    busy,
    drain: (nodes) => wrap(() => each(nodes, (id) => drainM.mutateAsync({ id }), (ok) => `Emptying ${names(ok)}: their apps move to your other servers.`)),
    label: (nodes, key, value) =>
      wrap(() => each(nodes, (id) => labelM.mutateAsync({ id, labels: { [key]: value } }), (ok) => `Labelled ${names(ok)} ${key}=${value}.`)),
    upgrade: (nodes) => wrap(() => each(nodes, (id) => upgradeM.mutateAsync({ id }), (ok) => `Upgrading the agent on ${names(ok)}.`)),
  };
}
