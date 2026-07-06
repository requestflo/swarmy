import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircleIcon } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, StatusBadge, toast } from '@swarmy/ui';
import { NODE_STATUS_TONE } from '@swarmy/core';
import type { NodeDetail, NodeStatsSnapshot } from '@swarmy/core';
import { bytes, cores, pct } from '@/lib/format';
import { useTRPC } from '@/integrations/trpc';

interface NodeDetailsPanelProps {
  node: NodeDetail | undefined;
  live: NodeStatsSnapshot | null | undefined;
}

/** Static facts about the node — status, role, sizing, agent — as a hairline list. */
export function NodeDetailsPanel({ node, live }: NodeDetailsPanelProps): React.JSX.Element {
  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Details</CardTitle>
      </CardHeader>
      <CardContent className="divide-border grid divide-y text-sm">
        <Row label="Status">
          <StatusBadge
            tone={node ? (NODE_STATUS_TONE[node.status] ?? 'neutral') : 'neutral'}
            label={node?.status ?? '—'}
          />
        </Row>
        <Row label="Role">
          <Badge variant={node?.role === 'manager' ? 'info' : 'muted'}>{node?.role ?? '—'}</Badge>
        </Row>
        <Row label="CPU now">
          <span className="mono-data">{pct(live?.cpuPercent)}</span>
        </Row>
        <Row label="Memory">
          <span className="mono-data">
            {bytes(live?.memUsedBytes)} / {bytes(live?.memTotalBytes)}
          </span>
        </Row>
        <Row label="Resources">
          <span className="mono-data">{cores(node?.resources.cpus ?? null)}</span>
        </Row>
        <Row label="Agent">
          <AgentVersionCell node={node} />
        </Row>
      </CardContent>
    </Card>
  );
}

/** Agent version + an "Update" affordance when this controller has a newer release. */
function AgentVersionCell({ node }: { node: NodeDetail | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const release = useQuery(trpc.nodes.agentRelease.queryOptions());
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

  const current = node?.agentVersion ?? null;
  const target = release.data?.version ?? null;
  const updateAvailable = Boolean(node && current && target && current !== target && node.status === 'online');

  return (
    <span className="inline-flex items-center gap-2">
      <span className="mono-data">{current ?? '—'}</span>
      {updateAvailable ? (
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          disabled={upgrade.isPending}
          onClick={() => node && upgrade.mutate({ id: node.id })}
        >
          <ArrowUpCircleIcon className="size-3.5" />
          {upgrade.isPending ? 'Updating…' : `Update to ${target}`}
        </Button>
      ) : null}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <span className="mono-label text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
