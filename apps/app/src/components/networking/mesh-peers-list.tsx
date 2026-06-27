import * as React from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  type StatusTone,
} from '@swarmy/ui';
import { WaypointsIcon } from 'lucide-react';

interface MeshPeer {
  id: string;
  nodeId: string;
  meshIp: string | null;
  lastSeen: string | Date | null;
  status: string;
}

interface MeshPeersListProps {
  peers: MeshPeer[];
}

function peerTone(status: string): StatusTone {
  switch (status.toUpperCase()) {
    case 'CONNECTED':
      return 'online';
    case 'FAILED':
      return 'offline';
    case 'ENROLLING':
    case 'ENROLLED':
      return 'progress';
    default:
      return 'neutral';
  }
}

/** Networking → flat list of nodes joined to the mesh with live status. */
export function MeshPeersList({ peers }: MeshPeersListProps): React.JSX.Element {
  const count = peers.length;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Peers</CardTitle>
        <CardDescription>Nodes joined to the mesh and their live status.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {count === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon={<WaypointsIcon />}
              title="No peers yet"
              description="Enable NetBird and enroll a node to mesh your fleet — every box reachable, no open ports."
              className="border-0"
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto] gap-x-4 px-6 pb-2 sm:grid-cols-[2fr_1.5fr_1fr_auto]">
              <span className="mono-label">Node</span>
              <span className="mono-label hidden sm:block">Mesh IP</span>
              <span className="mono-label hidden sm:block">Last seen</span>
              <span className="mono-label text-right">{count}</span>
            </div>
            <div className="border-t">
              {peers.map((p) => (
                <div
                  key={p.id}
                  className="hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0 sm:grid-cols-[2fr_1.5fr_1fr_auto]"
                >
                  <div className="min-w-0">
                    <p className="mono-data truncate font-medium">{p.nodeId}</p>
                    <p className="text-muted-foreground mono-label sm:hidden">
                      {p.meshIp ?? '—'} · {p.status.toLowerCase()}
                    </p>
                  </div>
                  <span className="mono-data hidden sm:block">{p.meshIp ?? '—'}</span>
                  <span className="mono-data text-muted-foreground hidden sm:block">
                    {p.lastSeen ? new Date(p.lastSeen).toLocaleTimeString() : '—'}
                  </span>
                  <div className="flex justify-end">
                    <StatusBadge tone={peerTone(p.status)} label={p.status.toLowerCase()} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
