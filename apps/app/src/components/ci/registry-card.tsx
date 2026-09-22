import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
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
  /** Login username only — the password never reaches the client. */
  username?: string | null;
  login?: 'auto-generated' | 'custom' | null;
  authEnforced?: boolean;
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

  const rotate = useMutation(
    trpc.cicd.rotateRegistryCredentials.mutationOptions({
      onSuccess: () => {
        toast.success('Registry login rotated — services that pull from it are rolling');
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
          A single-replica <span className="mono-data">registry:2</span> on the swarm routing mesh. Every node
          pulls from <span className="mono-data">localhost:5000</span> with no Docker daemon config. Pushes and
          pulls require an auto-generated login swarmy applies for you; still keep port 5000 firewalled from
          outside the swarm.
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
        {config?.enabled && (
          <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
            <div>
              <Label className="font-medium">Login</Label>
              <p className="text-muted-foreground text-xs">
                {config.login ? (
                  <>
                    <span className="mono-data">{config.username}</span> · {config.login}
                    {config.authEnforced ? ' · enforced' : ' · applying…'}
                  </>
                ) : (
                  'Not set — generated on enable.'
                )}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={rotate.isPending || !config.login}
              onClick={() => rotate.mutate()}
            >
              Rotate
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
