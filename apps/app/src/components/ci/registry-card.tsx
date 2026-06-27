import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  StatusBadge,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface RegistryConfig {
  enabled: boolean;
  host: string | null;
  online: boolean;
}

interface RegistryCardProps {
  config: RegistryConfig | undefined;
}

/** In-swarm registry toggle. Preserves the original mutation + invalidation. */
export function RegistryCard({ config }: RegistryCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const online = !!config?.online;

  const setRegistry = useMutation(
    trpc.cicd.setRegistryEnabled.mutationOptions({
      onSuccess: () => {
        toast.success('Registry updated');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          In-swarm registry
          <StatusBadge tone={online ? 'online' : 'neutral'} label={online ? 'Live' : 'Off'} />
        </CardTitle>
        <CardDescription>
          A single-replica <span className="mono-data">registry:2</span> on the{' '}
          <span className="mono-data">swarmy</span> overlay. Every node pulls over the network — never public.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
          <div>
            <Label className="font-medium">Enabled</Label>
            <p className="text-muted-foreground text-xs">
              {config?.host ? (
                <span className="mono-data">{config.host}</span>
              ) : (
                'Deploys one swarm service swarmy manages.'
              )}
            </p>
          </div>
          <Switch checked={!!config?.enabled} onCheckedChange={(v) => setRegistry.mutate({ enabled: v })} />
        </div>
      </CardContent>
    </Card>
  );
}
