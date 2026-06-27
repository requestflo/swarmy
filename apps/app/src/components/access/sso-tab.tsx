import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BuildingIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { enabledTone, type SsoProviderEntry } from '@/components/access/access-shared';

/** Enterprise SSO tab: per-org OIDC/SAML providers as flat rows in one card. */
export function SsoTab(): React.JSX.Element {
  const trpc = useTRPC();
  const list = useQuery(trpc.sso.list.queryOptions());
  const providers = list.data ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-xl text-sm">
          Per-org enterprise sign-in. OIDC routes by email domain (&ldquo;Sign in with your
          company&rdquo;).
        </p>
        <SsoEditor />
      </div>
      <Card className="card-pop border-0">
        <CardContent className="p-0">
          {providers.length === 0 ? (
            <div className="px-6 py-4">
              <EmptyState
                icon={<BuildingIcon />}
                title="No SSO providers yet"
                description="Wire an OIDC identity provider to let your company sign in with its own directory."
                action={<SsoEditor />}
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
                  <div
                    key={p.id}
                    className="hover:bg-accent/60 grid grid-cols-[1.5fr_auto] items-center gap-x-4 px-6 py-4 transition-colors sm:grid-cols-[2fr_1fr_1.5fr_1fr_auto]"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{p.providerId}</p>
                      <p className="text-muted-foreground mono-label truncate sm:hidden">
                        {p.protocol.toUpperCase()} · {p.domain ?? 'no domain'}
                      </p>
                    </div>
                    <span className="hidden sm:block">
                      <Badge variant="muted">{p.protocol.toUpperCase()}</Badge>
                    </span>
                    <span className="mono-data hidden truncate sm:block">{p.domain ?? '—'}</span>
                    <span className="hidden sm:block">
                      <StatusBadge
                        tone={enabledTone(p.enabled)}
                        label={p.enabled ? 'enabled' : 'disabled'}
                      />
                    </span>
                    <div className="flex justify-end">
                      <SsoEditor existing={p as SsoProviderEntry} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SsoEditor({ existing }: { existing?: SsoProviderEntry }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [providerId, setProviderId] = React.useState(existing?.providerId ?? '');
  const [protocol, setProtocol] = React.useState<'oidc' | 'saml'>(existing?.protocol ?? 'oidc');
  const [domain, setDomain] = React.useState(existing?.domain ?? '');
  const [issuer, setIssuer] = React.useState(existing?.issuer ?? '');
  const [discoveryUrl, setDiscoveryUrl] = React.useState(
    (existing?.metadata?.discoveryUrl as string) ?? '',
  );
  const [clientId, setClientId] = React.useState(existing?.clientId ?? '');
  const [clientSecret, setClientSecret] = React.useState('');

  const upsert = useMutation(
    trpc.sso.upsert.mutationOptions({
      onSuccess: () => {
        toast.success('SSO provider saved');
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.sso.delete.mutationOptions({
      onSuccess: () => {
        toast.success('SSO provider deleted');
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={existing ? 'ghost' : 'default'} size={existing ? 'sm' : 'default'}>
          {existing ? 'Edit' : 'Add provider'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit' : 'New'} SSO provider</DialogTitle>
          <DialogDescription>
            OIDC via discovery URL. Paste the callback URL into your IdP.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm">
          <div className="grid gap-1.5">
            <Label className="mono-label">Provider slug</Label>
            <Input
              value={providerId}
              placeholder="acme"
              onChange={(e) => setProviderId(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="mono-label">Protocol</Label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v as 'oidc' | 'saml')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="oidc">OIDC</SelectItem>
                  <SelectItem value="saml">SAML</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Email domain</Label>
              <Input
                value={domain}
                placeholder="acme.com"
                onChange={(e) => setDomain(e.target.value)}
              />
            </div>
          </div>
          {protocol === 'oidc' ? (
            <>
              <div className="grid gap-1.5">
                <Label className="mono-label">Discovery URL</Label>
                <Input
                  value={discoveryUrl}
                  placeholder="https://idp.acme.com/.well-known/openid-configuration"
                  onChange={(e) => setDiscoveryUrl(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="mono-label">Issuer (optional)</Label>
                <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="mono-label">Client ID</Label>
                  <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label className="mono-label">
                    Client secret{' '}
                    {existing?.hasSecret && <span className="text-status-online">• set</span>}
                  </Label>
                  <Input
                    type="password"
                    value={clientSecret}
                    placeholder={existing?.hasSecret ? '•••• (keep)' : 'paste secret'}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                </div>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">
              SAML config (IdP metadata XML, SP cert) is stored but not yet wired into sign-in on
              this controller — see release notes.
            </p>
          )}
          {existing && (
            <div className="grid gap-1.5">
              <Label className="mono-label">Callback URL (paste into IdP)</Label>
              <div className="flex items-center gap-2">
                <code className="bg-muted mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
                  {existing.callbackUrl}
                </code>
                <CopyButton value={existing.callbackUrl} label="Copy" />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <Button
              disabled={upsert.isPending || !providerId}
              onClick={() =>
                upsert.mutate({
                  id: existing?.id,
                  providerId,
                  protocol,
                  domain: domain || null,
                  issuer: issuer || null,
                  clientId: clientId || null,
                  clientSecret: clientSecret || undefined,
                  metadata: discoveryUrl ? { discoveryUrl } : {},
                })
              }
            >
              Save
            </Button>
            {existing && (
              <Button variant="ghost" onClick={() => del.mutate({ id: existing.id })}>
                <Trash2Icon className="size-4" /> Delete
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
