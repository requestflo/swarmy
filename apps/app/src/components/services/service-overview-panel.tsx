import * as React from 'react';
import { SERVICE_STATUS_TONE } from '@swarmy/core';
import type { ServiceDetail } from '@swarmy/core';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, StatusBadge } from '@swarmy/ui';

interface ServiceOverviewPanelProps {
  service: ServiceDetail | undefined;
  desired: number;
  onDesiredChange: (value: number) => void;
  onScale: () => void;
  scaling: boolean;
}

/** Status snapshot + scale control — the two things you act on most. */
export function ServiceOverviewPanel({
  service,
  desired,
  onDesiredChange,
  onScale,
  scaling,
}: ServiceOverviewPanelProps): React.JSX.Element {
  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
        </CardHeader>
        <CardContent className="divide-border grid divide-y text-sm">
          <DetailRow label="State">
            <StatusBadge
              tone={SERVICE_STATUS_TONE[service?.status ?? ''] ?? 'neutral'}
              label={service?.status ?? '—'}
            />
          </DetailRow>
          <DetailRow label="Replicas">
            <span className="mono-data">
              {service?.replicas.running ?? 0} / {service?.replicas.desired ?? 0}
            </span>
          </DetailRow>
          <DetailRow label="Ingress">
            {service?.ingressEnabled ? (
              <Badge variant="success">on</Badge>
            ) : (
              <Badge variant="muted">off</Badge>
            )}
          </DetailRow>
          <DetailRow label="Image">
            <span className="mono-data text-xs">{service?.image ?? '—'}</span>
          </DetailRow>
        </CardContent>
      </Card>

      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Scale</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="grid flex-1 gap-1">
            <span className="mono-label text-muted-foreground">Desired replicas</span>
            <Input
              type="number"
              min={0}
              className="mono-data"
              value={desired}
              onChange={(e) => onDesiredChange(Number(e.target.value))}
            />
          </div>
          <Button
            variant="outline"
            className="rounded-full font-bold"
            onClick={onScale}
            disabled={scaling}
          >
            Apply
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <span className="mono-label text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
