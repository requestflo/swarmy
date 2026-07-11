import * as React from 'react';
import { BoxesIcon } from 'lucide-react';
import type { InvContainer } from '@swarmy/core';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  type StatusTone,
} from '@swarmy/ui';

const STATE_TONE: Record<string, StatusTone> = {
  created: 'neutral',
  running: 'online',
  paused: 'warning',
  restarting: 'progress',
  removing: 'warning',
  exited: 'offline',
  dead: 'offline',
};

interface ServiceContainersListProps {
  containers: InvContainer[] | undefined;
  onScaleUp: () => void;
}

/** The actual containers behind this service — flat hairline rows, live from inventory. */
export function ServiceContainersList({ containers, onScaleUp }: ServiceContainersListProps): React.JSX.Element {
  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BoxesIcon className="text-primary size-4" /> Containers
          <span className="mono-data text-muted-foreground">{containers?.length ?? '…'}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-border grid divide-y">
        {containers === undefined ? (
          <div className="grid gap-3 py-1">
            <div className="shimmer-line h-5 w-2/3" />
            <div className="shimmer-line h-5 w-1/2" />
          </div>
        ) : null}
        {(containers ?? []).map((c) => {
          const tone = STATE_TONE[c.state] ?? 'neutral';
          return (
            <div
              key={c.id}
              className="hover:bg-accent/60 -mx-2 flex items-center justify-between gap-4 rounded-xl px-4 py-3 transition-colors"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{c.name}</p>
                <p className="mono-label text-muted-foreground truncate !mb-0">{c.image}</p>
              </div>
              <StatusBadge tone={tone} label={c.state} />
            </div>
          );
        })}
        {containers?.length === 0 ? (
          <EmptyState
            className="border-0"
            icon={<BoxesIcon />}
            title="Nothing running yet"
            description="Scale it up and swarmy will place containers across your nodes."
            action={
              <Button className="font-bold" onClick={onScaleUp}>
                Scale it up
              </Button>
            }
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
