import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
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

function curlExample(prefix: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `curl -H "Authorization: Bearer ${prefix}…" ${origin}/api/v1/services`;
}

function keyTone(status: string): React.ComponentProps<typeof StatusBadge>['tone'] {
  return status === 'active' ? 'online' : 'neutral';
}

/** Mint + manage org-scoped `swk_` API keys. */
export function ApiKeysTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const keys = useQuery(trpc.apiKeys.list.queryOptions());

  const [name, setName] = React.useState('');
  const [canWrite, setCanWrite] = React.useState(false);
  const [issued, setIssued] = React.useState<string | null>(null);

  const create = useMutation(
    trpc.apiKeys.create.mutationOptions({
      onSuccess: (res) => {
        setIssued(res.key);
        setName('');
        setCanWrite(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const revoke = useMutation(
    trpc.apiKeys.revoke.mutationOptions({
      onSuccess: () => {
        toast.success('Key revoked');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = keys.data ?? [];
  const active = rows.filter((k) => k.status === 'active').length;

  return (
    <div className="grid gap-6">
      <Card className="card-pop border-0">
        <CardContent className="grid gap-4 p-5">
          <div>
            <h2 className="font-display text-lg font-semibold">New API key</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Keys carry the permissions of their creator and are scoped to this org. The secret is
              shown <strong className="text-foreground">once</strong> — stash it in a secret manager
              or CI variable.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid min-w-[14rem] flex-1 gap-1.5">
              <Label htmlFor="key-name" className="mono-label">
                Name
              </Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ci-terraform"
              />
            </div>
            <div className="flex items-center gap-2 pb-2.5">
              <Switch id="key-write" checked={canWrite} onCheckedChange={setCanWrite} />
              <Label htmlFor="key-write" className="mono-label">
                Allow writes
              </Label>
            </div>
            <Button
              onClick={() =>
                create.mutate({ name, scopes: canWrite ? ['read', 'write'] : ['read'] })
              }
              disabled={create.isPending || !name}
            >
              <PlusIcon className="size-4" /> Create key
            </Button>
          </div>
        </CardContent>
      </Card>

      {issued && (
        <IssuedSecretPanel
          title="Copy it now — this key won't be shown again."
          lines={[
            { label: 'API key', value: issued },
            { label: 'Use it from anywhere', value: curlExample(issued) },
          ]}
        />
      )}

      <Card className={cn('card-pop border-0', rows.length > 0 && 'p-0')}>
        {rows.length === 0 ? (
          <EmptyState
            className="border-0 py-14"
            icon={<KeyRoundIcon />}
            title="No API keys yet"
            description="Mint one above to automate swarmy from curl, an SDK, or the Terraform provider."
          />
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <span className="mono-label">
                <CountUp value={rows.length} /> keys
              </span>
              <span className="text-muted-foreground mono-label">{active} active</span>
            </div>
            <div className="divide-border divide-y border-t">
              {rows.map((k) => (
                <div
                  key={k.id}
                  className={cn(
                    'hover:bg-accent/50 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors',
                    k.status === 'active' && 'bg-accent/40 border-l-[3px] border-l-primary pl-[17px]',
                  )}
                >
                  <div className="min-w-[10rem] flex-1">
                    <p className="truncate font-medium">{k.name}</p>
                    <p className="mono-data text-muted-foreground text-xs">swk_{k.prefix}…</p>
                  </div>
                  <div className="hidden md:block">
                    <p className="mono-label">Scopes</p>
                    <p className="mono-data text-sm">{k.scopes.join(', ')}</p>
                  </div>
                  <div className="hidden sm:block">
                    <p className="mono-label">Last used</p>
                    <p className="mono-data text-muted-foreground text-sm">
                      {k.lastUsedAt ? relTime(k.lastUsedAt) : '—'}
                    </p>
                  </div>
                  <div className="hidden sm:block">
                    <p className="mono-label">Created</p>
                    <p className="mono-data text-muted-foreground text-sm">{relTime(k.createdAt)}</p>
                  </div>
                  <StatusBadge tone={keyTone(k.status)} label={k.status} />
                  <div className="ml-auto">
                    {k.status === 'active' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate({ id: k.id })}
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
