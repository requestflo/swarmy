import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CanaryRunView } from '@swarmy/core';
import { Button, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relativeTime } from './release-status';

const tag = (image: string): string => image.split(':').pop() ?? image;

function RedCell({ label, pct, ceiling }: { label: string; pct: number | null; ceiling: number | null }): React.JSX.Element {
  const breach = pct !== null && ceiling !== null && pct > ceiling;
  return (
    <div>
      <p className="mono-label text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mono-data text-sm font-semibold',
          pct === null ? 'text-muted-foreground' : breach ? 'text-status-offline' : 'text-status-online',
        )}
      >
        {pct === null ? 'no data' : `${pct}% errors`}
      </p>
    </div>
  );
}

/**
 * One in-flight canary: live traffic split, error rates stable vs canary,
 * time left in the watch window, and the promote/abort levers.
 */
export function CanaryRunCard({ run }: { run: CanaryRunView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries();
  const promote = useMutation(
    trpc.releases.promote.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.service} promoted to ${tag(r.image)}`);
        done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const abort = useMutation(
    trpc.releases.abort.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Canary aborted — ${r.service} untouched`);
        done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const stablePct = 100 - run.trafficPct;
  const windowDone = run.remainingMin <= 0;
  const busy = promote.isPending || abort.isPending;

  return (
    <div className="grid gap-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{run.service}</p>
        <p className="mono-label text-muted-foreground">started {relativeTime(run.startedAt)}</p>
      </div>

      <p className="font-mono text-xs">
        <span className="text-muted-foreground">{tag(run.stableImage)}</span>
        <span className="text-primary font-semibold"> → {tag(run.canaryImage)}</span>
      </p>

      {/* Traffic split — stable (green) vs canary (coral). */}
      <div>
        <div className="bg-muted flex h-2 overflow-hidden rounded-full">
          <div className="bg-status-online/70" style={{ width: `${stablePct}%` }} />
          <div className="bg-primary" style={{ width: `${run.trafficPct}%` }} />
        </div>
        <div className="text-muted-foreground mt-1 flex justify-between text-xs">
          <span className="mono-data">stable {stablePct}%</span>
          <span className="mono-data text-primary">canary {run.trafficPct}%</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <RedCell label={`Stable · ${run.stableReplicas.running}/${run.stableReplicas.desired}`} pct={run.stableRed.errorRatePct} ceiling={run.rollbackOnErrorRatePct} />
        <RedCell label={`Canary · ${run.canaryReplicas.running}/${run.canaryReplicas.desired}`} pct={run.canaryRed.errorRatePct} ceiling={run.rollbackOnErrorRatePct} />
      </div>

      <p className="text-muted-foreground text-xs">
        {windowDone ? (
          <span className="text-status-progress font-medium">Watch window elapsed — promoting on the next pass.</span>
        ) : (
          <>
            <span className="mono-data">{run.remainingMin}m</span> left of a{' '}
            <span className="mono-data">{run.durationMin}m</span> window
            {run.rollbackOnErrorRatePct !== null ? (
              <>
                {' '}
                · rolls back over <span className="mono-data">{run.rollbackOnErrorRatePct}%</span> errors
              </>
            ) : null}
            {run.routedHosts.length > 0 ? <> · live on {run.routedHosts.join(', ')}</> : ' · no routed hosts (observe-only)'}
          </>
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => promote.mutate({ stack: run.stack, service: run.service })}>
          {promote.isPending ? 'Promoting…' : 'Promote now'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-status-offline/40 text-status-offline hover:bg-status-offline/10"
          disabled={busy}
          onClick={() => abort.mutate({ stack: run.stack, service: run.service })}
        >
          {abort.isPending ? 'Aborting…' : 'Abort'}
        </Button>
      </div>
    </div>
  );
}
