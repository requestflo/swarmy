import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { QuietSwitch } from '@/components/rowpage/row-page';
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
    <Card className="calm-card border-0">
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
          <QuietSwitch aria-label="Built-in registry" checked={!!config?.enabled} onCheckedChange={(v) => setRegistry.mutate({ enabled: v })} />
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
        {config?.enabled && <HubCacheLogin />}
      </CardContent>
    </Card>
  );
}

/**
 * Docker Hub login for the pull-through cache (`swarmy-registry-cache`).
 * Anonymous Hub pulls are capped per IP; once the cap hits, every docker.io
 * deploy fails. The token is stored as a Docker secret, never shown again.
 */
function HubCacheLogin(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const cache = useQuery(trpc.cicd.getRegistryCache.queryOptions());
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const save = useMutation(
    trpc.cicd.setRegistryCacheCredentials.mutationOptions({
      onSuccess: (_r, vars) => {
        toast.success(vars.login ? 'Docker Hub login saved — the cache is rolling' : 'Docker Hub login removed');
        setPassword('');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const current = cache.data?.username ?? null;
  return (
    <div className="bg-accent/40 grid gap-3 rounded-xl px-4 py-3">
      <div>
        <Label className="font-medium">Docker Hub login (pull-through cache)</Label>
        <p className="text-muted-foreground text-xs">
          {current ? (
            <>
              <span className="mono-data">{current}</span>
              {cache.data?.applied ? ' · in use' : ' · applying…'}
            </>
          ) : (
            'Anonymous — Docker Hub rate-limits anonymous pulls per IP. Add a login (an access token works) to lift it.'
          )}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="Docker Hub username"
          placeholder="Docker Hub username"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Input
          aria-label="Docker Hub password or access token"
          placeholder="Password or access token"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        {current ? (
          <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => save.mutate({ login: null })}>
            Remove
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={save.isPending || !username.trim() || !password}
          onClick={() => save.mutate({ login: { username: username.trim(), password } })}
        >
          Save login
        </Button>
      </div>
    </div>
  );
}
