import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseIcon } from 'lucide-react';
import { Card, CardContent } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DbClusterRow } from './db-cluster-row';
import { DbDeclareClusterForm } from './db-declare-cluster-form';

/**
 * Stack-level managed-database panel (epic #8).
 *
 * The "magic" surface: declare "postgres, 1 primary + N read replicas" for a
 * stack and swarmy provisions it on the swarm and exposes stable rw/ro hosts —
 * no manual wiring. Shows live primary/replica health, lets you scale replicas
 * with +/- (Docker-truth label, reconciled), and wire an app service to the
 * cluster's DATABASE_URL.
 */
export function ManagedDbPanel({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();

  const topology = useQuery({
    ...trpc.db.get.queryOptions({ stack }),
    refetchInterval: 4_000,
  });
  const clusters = topology.data?.clusters ?? [];

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <DatabaseIcon className="size-5" />
          </span>
          <div>
            <h3 className="font-semibold leading-tight">Managed databases</h3>
            <p className="text-muted-foreground mono-label">
              {clusters.length > 0
                ? `${clusters.length} database${clusters.length === 1 ? '' : 's'} · add as many as the stack needs`
                : 'Postgres primary/replica · provisioned + wired automatically'}
            </p>
          </div>
        </div>

        {clusters.length > 0 && (
          <div className="space-y-4">
            {clusters.map((c) => (
              <DbClusterRow key={c.name} stack={stack} cluster={c} />
            ))}
          </div>
        )}

        <DbDeclareClusterForm stack={stack} existingNames={clusters.map((c) => c.name)} />
      </CardContent>
    </Card>
  );
}
