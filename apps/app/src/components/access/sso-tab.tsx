import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BuildingIcon, PlusIcon } from 'lucide-react';
import { Button, Card, CardContent, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { SsoProviderEntry } from './access-shared';
import { SsoCreateCard } from './sso-create-card';
import { SsoProviderRow } from './sso-provider-row';

/** Enterprise SSO tab: per-org OIDC/SAML providers as flat rows in one card, all inline. */
export function SsoTab(): React.JSX.Element {
  const trpc = useTRPC();
  const list = useQuery(trpc.sso.list.queryOptions());
  const providers = (list.data ?? []) as SsoProviderEntry[];
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-xl text-sm">
          Per-org enterprise sign-in. OIDC routes by email domain (&ldquo;Sign in with your
          company&rdquo;).
        </p>
        <Button onClick={() => setCreateOpen((o) => !o)}>
          <PlusIcon className="size-4" /> Add provider
        </Button>
      </div>

      <SsoCreateCard open={createOpen} onOpenChange={setCreateOpen} />

      <Card className="card-pop border-0">
        <CardContent className="p-0">
          {providers.length === 0 ? (
            <div className="px-6 py-4">
              <EmptyState
                icon={<BuildingIcon />}
                title="No SSO providers yet"
                description="Wire an OIDC identity provider to let your company sign in with its own directory."
                action={
                  <Button variant="outline" onClick={() => setCreateOpen(true)}>
                    <PlusIcon className="size-4" /> Add provider
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1.5fr_auto] gap-x-4 px-6 py-3 sm:grid-cols-[2fr_1fr_1.5fr_1fr_auto]">
                <span className="mono-label">Provider</span>
                <span className="mono-label hidden sm:block">Protocol</span>
                <span className="mono-label hidden sm:block">Domain</span>
                <span className="mono-label hidden sm:block">Status</span>
                <span className="mono-label text-right">Edit</span>
              </div>
              <div className="divide-border divide-y border-t">
                {providers.map((p) => (
                  <SsoProviderRow
                    key={p.id}
                    provider={p}
                    expanded={editing === p.id}
                    onToggle={() => setEditing((cur) => (cur === p.id ? null : p.id))}
                  />
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
