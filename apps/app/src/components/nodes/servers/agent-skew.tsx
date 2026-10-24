import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { Button, cn, toast } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { agentSkewWords } from './server-words';

/** Servers list: a small pill when a server's agent is out of step with swarmy. */
export function AgentSkewBadge({ node }: { node: Pick<NodeSummary, 'agentSkew'> }): React.JSX.Element | null {
  const w = agentSkewWords(node);
  if (!w) return null;
  return (
    <span
      title={w.say}
      className={cn('border-border hidden shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold sm:inline', TONE_TEXT[w.tone])}
    >
      {w.word}
    </span>
  );
}

/**
 * Server detail: "This server's agent is two versions behind — Upgrade agent".
 * One plain line under the header; the button pushes this controller's agent
 * build to the server (`nodes.upgradeAgent`), the same as the inspector's.
 */
export function AgentSkewLine({ node }: { node: NodeSummary }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const upgrade = useMutation(
    trpc.nodes.upgradeAgent.mutationOptions({
      onSuccess: (r) => {
        if ('upToDate' in r) toast.info('Agent is already up to date');
        else toast.success(`Agent updating to ${r.targetVersion} — it will reconnect shortly`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const w = agentSkewWords(node);
  if (!w) return null;
  const canUpgrade = w.upgrade && node.status === 'online';
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[w.tone])} />
      <span className={cn('font-medium', TONE_TEXT[w.tone])}>{w.say}</span>
      {canUpgrade ? (
        <>
          <span aria-hidden className="text-muted-foreground">—</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs pointer-coarse:min-h-11"
            disabled={upgrade.isPending}
            onClick={() => upgrade.mutate({ id: node.id })}
          >
            {upgrade.isPending ? 'Upgrading…' : 'Upgrade agent'}
          </Button>
        </>
      ) : w.upgrade ? (
        <span className="text-muted-foreground">— upgrade it once it’s back online.</span>
      ) : null}
    </p>
  );
}
