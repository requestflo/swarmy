import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IncidentDetailView, Inventory, ReleaseView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { blastRadius, type Blast } from './blast-radius';
import { bestGuess, slowestSpan, type Guess } from './incident-guess';
import type { IncidentScope } from './incident-scope';

/**
 * The signals behind the best guess and the blast radius: the worst recent
 * error trace for the app (and its slowest span), the servers, and the front
 * door's traffic. `guess` / `blast` stay undefined until their inputs settle.
 */
export function useIncidentEvidence(
  incident: IncidentDetailView,
  scope: IncidentScope,
  inventory: Inventory | undefined,
  releases: ReleaseView[] | undefined,
): { guess: Guess | undefined; blast: Blast | null | undefined } {
  const trpc = useTRPC();
  const app = scope.app ?? '';
  const traces = useQuery({
    ...trpc.observability.traces.queryOptions({ stack: app, errorsOnly: true, windowMinutes: 60, limit: 50 }),
    enabled: scope.app !== null,
    refetchInterval: 30_000,
  });
  const worst = [...(traces.data?.traces ?? [])].sort((a, b) => b.duration_ms - a.duration_ms)[0];
  const detail = useQuery({
    ...trpc.observability.traceDetail.queryOptions({ traceId: worst?.trace_id ?? '' }),
    enabled: worst !== undefined,
  });
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 15_000 });
  const traffic = useQuery({ ...trpc.traffic.now.queryOptions(), refetchInterval: 30_000 });

  const tracesSettled = scope.app === null || !traces.isPending;
  const detailSettled = worst === undefined || !detail.isPending;
  const guess = React.useMemo(() => {
    if (!releases || !tracesSettled || !detailSettled || nodes.isPending) return undefined;
    const span = worst && detail.data?.status === 'ok' ? slowestSpan(worst.trace_id, detail.data.spans) : null;
    return bestGuess({ openedAt: incident.openedAt, releases, slowSpan: span, servers: nodes.data ?? null });
  }, [releases, tracesSettled, detailSettled, nodes.isPending, nodes.data, worst, detail.data, incident.openedAt]);

  const blast = React.useMemo(() => {
    if (!scope.app) return null;
    if (!inventory || traffic.isPending) return undefined;
    return blastRadius({
      app: scope.app,
      part: scope.part,
      services: inventory.services,
      edges: inventory.edges,
      traffic: traffic.data?.apps.find((a) => a.app === scope.app),
      durationSec: incident.durationSec,
    });
  }, [scope.app, scope.part, inventory, traffic.isPending, traffic.data, incident.durationSec]);

  return { guess, blast };
}
