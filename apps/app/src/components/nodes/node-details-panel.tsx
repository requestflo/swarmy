import * as React from 'react';
import { Badge, Card, CardContent, CardHeader, CardTitle, StatusBadge } from '@swarmy/ui';
import { NODE_STATUS_TONE } from '@swarmy/core';
import type { NodeDetail, NodeStatsSnapshot } from '@swarmy/core';
import { bytes, cores, pct } from '@/lib/format';

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
          <span className="mono-data">{node?.agentVersion ?? '—'}</span>
        </Row>
      </CardContent>
    </Card>
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
