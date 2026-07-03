import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { GlobeIcon } from 'lucide-react';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, StatusBadge, type StatusTone } from '@swarmy/ui';
import { CountUp } from '@/components/count-up';
import { DRIVER_LABELS, type IngressDriverId } from './driver-config';

interface DomainRow {
  id: string;
  host: string;
  stack: string;
  serviceName: string;
  targetPort: number;
  tls: string;
  ingressDriver: IngressDriverId | null;
}

function tlsTone(tls: string): StatusTone {
  if (tls === 'auto') return 'online';
  if (tls === 'custom') return 'progress';
  return 'neutral';
}

/**
 * Read-only fleet-wide domain roster. Adding, removing and protecting a route
 * is now a stack concern — done from that stack's Network tab, linked per row.
 */
export function DomainsList({ domains }: { domains: DomainRow[] }): React.JSX.Element {
  const total = domains.length;
  const secured = domains.filter((d) => d.tls === 'auto' || d.tls === 'custom').length;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">All domains</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {total === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<GlobeIcon />}
              title="No domains routed yet"
              description="Map a hostname from a stack's Network tab and it shows up here."
            />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 px-6 py-4">
              <span className="mono-label">
                <CountUp value={secured} /> / {total} secured
              </span>
              <span className="text-muted-foreground mono-label">{total} routed</span>
            </div>
            <div className="divide-border divide-y border-t">
              {domains.map((d) => (
                <Link
                  key={d.id}
                  to="/stacks/$name/network"
                  params={{ name: d.stack }}
                  className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="mono-data truncate font-medium">{d.host}</p>
                    <p className="text-muted-foreground mono-label truncate">
                      {d.stack} · {d.serviceName} · :{d.targetPort}
                    </p>
                  </div>
                  {d.ingressDriver ? (
                    <Badge variant="muted" className="hidden md:inline-flex">
                      {DRIVER_LABELS[d.ingressDriver]}
                    </Badge>
                  ) : null}
                  <StatusBadge tone={tlsTone(d.tls)} label={`TLS ${d.tls}`} className="hidden sm:inline-flex" />
                </Link>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
