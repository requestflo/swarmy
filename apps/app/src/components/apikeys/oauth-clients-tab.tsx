import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, ShieldCheckIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Label,
  StatusBadge,
  Switch,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { relTime } from '@/lib/format';
import { IssuedSecretPanel } from './issued-secret-panel';

function tokenExchange(clientId: string, clientSecret: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `curl -X POST ${origin}/oauth/token -d grant_type=client_credentials -d client_id=${clientId} -d client_secret=${clientSecret}`;
}

function clientTone(status: string): React.ComponentProps<typeof StatusBadge>['tone'] {
  return status === 'active' ? 'online' : 'neutral';
}

/** Mint + manage OAuth2 client-credentials clients (`swc_` / `swcs_`). */
export function OauthClientsTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const clients = useQuery(trpc.oauth.list.queryOptions());

  const [name, setName] = React.useState('');
  const [canWrite, setCanWrite] = React.useState(false);
  const [issued, setIssued] = React.useState<{ clientId: string; clientSecret: string } | null>(
    null,
  );

  const create = useMutation(
    trpc.oauth.create.mutationOptions({
      onSuccess: (res) => {
        setIssued({ clientId: res.clientId, clientSecret: res.clientSecret });
        setName('');
        setCanWrite(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const revoke = useMutation(
    trpc.oauth.revoke.mutationOptions({
      onSuccess: () => {
        toast.success('Client revoked');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = clients.data ?? [];
  const active = rows.filter((c) => c.status === 'active').length;

  return (
    <div className="grid gap-6">
      <Card className="card-pop border-0">
        <CardContent className="grid gap-4 p-5">
          <div>
            <h2 className="font-display text-lg font-semibold">New OAuth client</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Machine-to-machine auth. Exchange the client credentials at{' '}
              <code className="mono-data text-foreground text-xs">POST /oauth/token</code> for a
              short-lived bearer token. The secret is shown{' '}
              <strong className="text-foreground">once</strong>.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid min-w-[14rem] flex-1 gap-1.5">
              <Label htmlFor="client-name" className="mono-label">
                Name
              </Label>
              <Input
                id="client-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="terraform-ci"
              />
            </div>
            <div className="flex items-center gap-2 pb-2.5">
              <Switch id="client-write" checked={canWrite} onCheckedChange={setCanWrite} />
              <Label htmlFor="client-write" className="mono-label">
                Allow writes
              </Label>
            </div>
            <Button
              onClick={() =>
                create.mutate({ name, scopes: canWrite ? ['read', 'write'] : ['read'] })
              }
              disabled={create.isPending || !name}
            >
              <PlusIcon className="size-4" /> Create client
            </Button>
          </div>
        </CardContent>
      </Card>

      {issued && (
        <IssuedSecretPanel
          title="Copy the secret now — it won't be shown again."
          lines={[
            { label: 'Client ID', value: issued.clientId },
            { label: 'Client secret', value: issued.clientSecret },
            { label: 'Exchange for a token', value: tokenExchange(issued.clientId, issued.clientSecret) },
          ]}
        />
      )}

      <Card className={cn('card-pop border-0', rows.length > 0 && 'p-0')}>
        {rows.length === 0 ? (
          <EmptyState
            className="border-0 py-14"
            icon={<ShieldCheckIcon />}
            title="No OAuth clients yet"
            description="Create one above for headless, rotating auth — ideal for CI and the Terraform provider."
          />
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <span className="mono-label">
                <CountUp value={rows.length} /> clients
              </span>
              <span className="text-muted-foreground mono-label">{active} active</span>
            </div>
            <div className="divide-border divide-y border-t">
              {rows.map((c) => (
                <div
                  key={c.id}
                  className={cn(
                    'hover:bg-accent/50 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors',
                    c.status === 'active' && 'bg-accent/40 border-l-[3px] border-l-primary pl-[17px]',
                  )}
                >
                  <div className="min-w-[10rem] flex-1">
                    <p className="truncate font-medium">{c.name}</p>
                    <p className="mono-data text-muted-foreground text-xs">{c.clientId}</p>
                  </div>
                  <div className="hidden md:block">
                    <p className="mono-label">Scopes</p>
                    <p className="mono-data text-sm">{c.scopes.join(', ')}</p>
                  </div>
                  <div className="hidden sm:block">
                    <p className="mono-label">Last used</p>
                    <p className="mono-data text-muted-foreground text-sm">
                      {c.lastUsedAt ? relTime(c.lastUsedAt) : '—'}
                    </p>
                  </div>
                  <div className="hidden sm:block">
                    <p className="mono-label">Created</p>
                    <p className="mono-data text-muted-foreground text-sm">{relTime(c.createdAt)}</p>
                  </div>
                  <StatusBadge tone={clientTone(c.status)} label={c.status} />
                  <div className="ml-auto">
                    {c.status === 'active' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate({ id: c.id })}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
