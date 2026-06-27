import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GlobeIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  type StatusTone,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { AddDomainDialog } from './add-domain-dialog';
import { DRIVER_LABELS, type IngressDriverId } from './driver-config';

interface DomainRow {
  id: string;
  host: string;
  serviceName: string;
  targetPort: number;
  tls: string;
  ingressDriver: IngressDriverId | null;
}

interface DomainService {
  id: string;
  name: string;
}

function tlsTone(tls: string): StatusTone {
  if (tls === 'auto') return 'online';
  if (tls === 'custom') return 'progress';
  return 'neutral';
}

/** Flat domain rows inside one card-pop, divided by hairlines. */
export function DomainsList({
  domains,
  services,
}: {
  domains: DomainRow[];
  services: DomainService[];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const removeDomain = useMutation(
    trpc.ingress.removeDomain.mutationOptions({
      onSuccess: () => qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  const total = domains.length;
  const secured = domains.filter((d) => d.tls === 'auto' || d.tls === 'custom').length;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Domains</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {total === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<GlobeIcon />}
              title="No domains routed yet"
              description="Point a hostname at a service and swarmy starts sending it traffic."
              action={<AddDomainDialog services={services} variant="outline" />}
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
                <div
                  key={d.id}
                  className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="mono-data truncate font-medium">{d.host}</p>
                    <p className="text-muted-foreground mono-label truncate">
                      {d.serviceName} · :{d.targetPort}
                    </p>
                  </div>
                  <StatusBadge tone={tlsTone(d.tls)} label={`TLS ${d.tls}`} className="hidden sm:inline-flex" />
                  {d.ingressDriver ? (
                    <Badge variant="muted" className="hidden md:inline-flex">
                      {DRIVER_LABELS[d.ingressDriver]}
                    </Badge>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${d.host}`}
                    onClick={() => removeDomain.mutate({ id: d.id })}
                    disabled={removeDomain.isPending}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
