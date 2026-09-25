import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import type { HealthStatusView } from '@swarmy/core';
import { Section, StatusWord, Tech, type Tone } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';

const TONE: Record<HealthStatusView, Tone> = { healthy: 'ok', degraded: 'warn', down: 'bad', unknown: 'idle' };
const WORD: Record<HealthStatusView, string> = { healthy: 'Healthy', degraded: 'Needs a look', down: 'Down', unknown: 'No signals yet' };

/**
 * The health narrative in plain words: one status and the ordered reasons
 * behind it ("p95 latency 1.8s (target <1.5s)", "database replica lag 12s"),
 * composed on read from live tasks, replica lag, queue depth and RED rows.
 */
export function HealthReasonsPanel({ stack }: { stack?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const health = useQuery({ ...trpc.observability.health.queryOptions({ stack }), refetchInterval: 10_000 });
  const status: HealthStatusView = health.data?.status ?? 'unknown';
  const reasons = health.data?.reasons ?? [];
  const entries = health.data?.entries ?? [];

  return (
    <Section title="What swarmy is watching" action={health.data ? <StatusWord tone={TONE[status]} word={WORD[status]} /> : null}>
      {health.isPending ? (
        <CardSkeleton lines={2} className="border-0 p-0 shadow-none" />
      ) : health.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-tone-bad text-sm">Couldn’t read health: {health.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => void health.refetch()}>
            Retry
          </Button>
        </div>
      ) : reasons.length === 0 ? (
        <p className="text-[14px]">
          {status === 'unknown' ? 'Quiet so far. Deploy something and health lands here.' : 'Every service is running at the size you asked for. Nothing needs you.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-2 text-[14px]">
              <StatusWord tone={reason.startsWith('telemetry') ? 'idle' : TONE[status]} word="" className="mt-1.5" />
              <span className="min-w-0 break-words">{reason}</span>
            </li>
          ))}
        </ul>
      )}
      {entries.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {entries.map((e) => (
            <StatusWord key={`${e.kind}:${e.name}`} tone={TONE[e.status]} word={e.name} />
          ))}
        </div>
      ) : null}
      <Tech>composed on read · live tasks + replica lag + queue depth + RED (p95 &lt; 1.5 s, error rate &lt; 5 %) · collector reachability</Tech>
    </Section>
  );
}
