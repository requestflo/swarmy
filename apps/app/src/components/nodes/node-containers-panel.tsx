import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { BoxesIcon } from 'lucide-react';
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

/** The container fields this list renders (subset of the agent container view). */
export interface NodeContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

const STATE_TONE: Record<string, StatusTone> = {
  created: 'neutral',
  running: 'online',
  paused: 'warning',
  restarting: 'progress',
  removing: 'warning',
  exited: 'offline',
  dead: 'offline',
};

interface NodeContainersPanelProps {
  containers: NodeContainer[] | undefined;
}

/** Everything running on this host — a flat hairline list, never per-row cards. */
export function NodeContainersPanel({ containers }: NodeContainersPanelProps): React.JSX.Element {
  const rows = containers ?? [];
  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BoxesIcon className="text-primary size-4" /> Containers
          <span className="mono-data text-muted-foreground">{rows.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-border grid divide-y">
        {rows.map((c) => {
          const tone = STATE_TONE[c.state] ?? 'neutral';
          return (
            <div
              key={c.id}
              className="hover:bg-accent/60 -mx-2 flex items-center justify-between gap-4 rounded-xl px-4 py-3 transition-colors"
            >
              <div className="flex min-w-0 items-center gap-3">
                <StatusBadge tone={tone} label="" />
                <div className="min-w-0">
                  <p className="truncate font-medium">{c.name}</p>
                  <p className="mono-label text-muted-foreground truncate">{c.image}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <span className="mono-data text-muted-foreground hidden text-xs sm:inline">
                  {c.status}
                </span>
                <StatusBadge tone={tone} label={c.state} />
              </div>
            </div>
          );
        })}
        {containers?.length === 0 ? (
          <EmptyState
            className="border-0"
            icon={<BoxesIcon />}
            title="Nothing running here yet"
            description="Deploy a service and swarmy will place containers on this node."
            action={
              <Button asChild className="font-bold">
                <Link to="/services/new">Deploy a service</Link>
              </Button>
            }
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
