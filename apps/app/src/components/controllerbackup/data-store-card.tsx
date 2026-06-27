import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ServerIcon } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Data-store mode + managed-Postgres upgrade. Lite mode embeds PGlite; multi-node
 * operators are nudged to upgrade to a swarmy-managed Postgres for the control
 * plane. Same dialect, one schema.
 */
export function DataStoreCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const summary = useQuery(trpc.system.dashboardSummary.queryOptions());
  const multiNode = (summary.data?.nodes.total ?? 0) > 1;

  const provision = useMutation(
    trpc.controllerBackup.provisionManagedPostgres.mutationOptions({
      onSuccess: (res) => {
        toast.success(`Managed Postgres deployed as "${res.serviceName}"`);
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <ServerIcon className="size-4" /> Data store
          </CardTitle>
          <CardDescription>
            Lite mode runs an embedded Postgres (PGlite) inside the controller — zero dependencies,
            single node. Upgrade to a swarmy-managed Postgres when you go multi-node.
          </CardDescription>
        </div>
        <StatusBadge
          tone={multiNode ? 'warning' : 'online'}
          label={multiNode ? 'upgrade recommended' : 'lite mode'}
        />
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge variant="muted">Same Postgres dialect, one schema</Badge>
          {multiNode ? (
            <span className="text-muted-foreground">
              You&apos;re multi-node — upgrading the controller database is recommended for
              reliability.
            </span>
          ) : null}
        </div>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => provision.mutate()}
            disabled={provision.isPending}
          >
            Upgrade to managed Postgres
          </Button>
        </div>
        {provision.data ? (
          <Alert>
            <AlertTitle className="font-bold">Managed Postgres is up. Finish the migrate:</AlertTitle>
            <AlertDescription>
              <ol className="mono-data mt-2 list-decimal space-y-1 pl-5 text-xs">
                {provision.data.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
