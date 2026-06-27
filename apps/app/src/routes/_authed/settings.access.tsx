import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GithubIcon,
  ShieldCheckIcon,
  KeyRoundIcon,
  MailIcon,
  Trash2Icon,
  PlayIcon,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { authClient } from '@swarmy/auth/client';

export const Route = createFileRoute('/_authed/settings/access')({
  component: AccessPage,
});

function AccessPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Access"
        title={<>Who gets <em>in</em>, and what they can do.</>}
        description="Flip on sign-in providers, wire enterprise SSO, and shape access with policies — live, no restart."
      />
      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">Sign-in</TabsTrigger>
          <TabsTrigger value="sso">Enterprise SSO</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="mt-6">
          <ProvidersTab />
        </TabsContent>
        <TabsContent value="sso" className="mt-6">
          <SsoTab />
        </TabsContent>
        <TabsContent value="members" className="mt-6">
          <MembersTab />
        </TabsContent>
        <TabsContent value="policies" className="mt-6">
          <PoliciesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Sign-in providers (social + passkey + magic-link) ───────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  passkey: 'Passkeys',
  magic_link: 'Magic link',
};

interface ProviderEntry {
  type: string;
  kind: 'social' | 'method';
  enabled: boolean;
  clientId: string | null;
  hasSecret: boolean;
  scopes: string[];
  callbackUrl: string;
}

function ProvidersTab(): React.JSX.Element {
  const trpc = useTRPC();
  const providers = useQuery(trpc.authConfig.listProviders.queryOptions());
  const social = (providers.data ?? []).filter((p) => p.kind === 'social');
  const methods = (providers.data ?? []).filter((p) => p.kind === 'method');
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        {social.map((p) => (
          <ProviderCard key={p.type} provider={p as ProviderEntry} />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {methods.map((p) => (
          <MethodCard key={p.type} provider={p as ProviderEntry} />
        ))}
      </div>
      {providers.data?.length === 0 && (
        <p className="text-muted-foreground text-sm">No providers available.</p>
      )}
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderEntry }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [clientId, setClientId] = React.useState(provider.clientId ?? '');
  const [clientSecret, setClientSecret] = React.useState('');

  const save = useMutation(
    trpc.authConfig.setProvider.mutationOptions({
      onSuccess: () => {
        setClientSecret('');
        toast.success(`${PROVIDER_LABELS[provider.type] ?? provider.type} updated`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          {provider.type === 'github' ? (
            <GithubIcon className="size-5" />
          ) : (
            <ShieldCheckIcon className="size-5" />
          )}
          <CardTitle className="text-base">
            {PROVIDER_LABELS[provider.type] ?? provider.type}
          </CardTitle>
          {provider.enabled && <Badge variant="success">on</Badge>}
        </div>
        <Switch
          checked={provider.enabled}
          onCheckedChange={(enabled) => save.mutate({ type: provider.type, enabled })}
          disabled={save.isPending}
        />
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-1.5">
          <Label className="mono-label">Callback URL</Label>
          <div className="flex items-center gap-2">
            <code className="bg-muted mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
              {provider.callbackUrl}
            </code>
            <CopyButton value={provider.callbackUrl} label="Copy" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Client ID</Label>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">
            Client secret {provider.hasSecret && <span className="text-status-online">• set</span>}
          </Label>
          <Input
            type="password"
            value={clientSecret}
            placeholder={provider.hasSecret ? '•••••••• (leave blank to keep)' : 'paste secret'}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
        <Button
          onClick={() =>
            save.mutate({ type: provider.type, clientId, clientSecret: clientSecret || undefined })
          }
          disabled={save.isPending}
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function MethodCard({ provider }: { provider: ProviderEntry }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const save = useMutation(
    trpc.authConfig.setProvider.mutationOptions({
      onSuccess: () => {
        toast.success(`${PROVIDER_LABELS[provider.type] ?? provider.type} updated`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const isPasskey = provider.type === 'passkey';

  const enrollPasskey = async () => {
    try {
      // Requires the passkey client plugin (see INTEGRATION). Guarded so the UI
      // degrades gracefully when the plugin is absent.
      const client = authClient as unknown as {
        passkey?: { addPasskey: () => Promise<unknown> };
      };
      if (!client.passkey?.addPasskey) {
        toast.error('Passkey plugin not installed on this controller');
        return;
      }
      await client.passkey.addPasskey();
      toast.success('Passkey registered');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Passkey enrolment failed');
    }
  };

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          {isPasskey ? <KeyRoundIcon className="size-5" /> : <MailIcon className="size-5" />}
          <CardTitle className="text-base">
            {PROVIDER_LABELS[provider.type] ?? provider.type}
          </CardTitle>
          {provider.enabled && <Badge variant="success">on</Badge>}
        </div>
        <Switch
          checked={provider.enabled}
          onCheckedChange={(enabled) => save.mutate({ type: provider.type, enabled })}
          disabled={save.isPending}
        />
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          {isPasskey
            ? 'Passwordless WebAuthn sign-in. No secret to configure.'
            : 'Email a one-time sign-in link. Needs a configured email sender.'}
        </p>
        {isPasskey && provider.enabled && (
          <Button variant="outline" className="w-fit" onClick={() => void enrollPasskey()}>
            Register a passkey
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ── Enterprise SSO ──────────────────────────────────────────────────────────

interface SsoProviderEntry {
  id: string;
  providerId: string;
  protocol: 'oidc' | 'saml';
  domain: string | null;
  issuer: string | null;
  clientId: string | null;
  hasSecret: boolean;
  enabled: boolean;
  metadata: Record<string, unknown>;
  mapping: Record<string, string>;
  callbackUrl: string;
  loginUrl: string;
}

function SsoTab(): React.JSX.Element {
  const trpc = useTRPC();
  const list = useQuery(trpc.sso.list.queryOptions());
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Per-org enterprise sign-in. OIDC routes by email domain (&ldquo;Sign in with your
          company&rdquo;).
        </p>
        <SsoEditor />
      </div>
      <Card className="card-pop border-0">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="mono-label">Provider</TableHead>
                <TableHead className="mono-label">Protocol</TableHead>
                <TableHead className="mono-label">Domain</TableHead>
                <TableHead className="mono-label">Status</TableHead>
                <TableHead className="mono-label text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.providerId}</TableCell>
                  <TableCell>
                    <Badge variant="muted">{p.protocol.toUpperCase()}</Badge>
                  </TableCell>
                  <TableCell className="mono-data">{p.domain ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={p.enabled ? 'success' : 'muted'}>
                      {p.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <SsoEditor existing={p as SsoProviderEntry} />
                  </TableCell>
                </TableRow>
              ))}
              {list.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-10 text-center text-sm">
                    No SSO providers yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
              <Input value={domain} placeholder="acme.com" onChange={(e) => setDomain(e.target.value)} />
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
                    Client secret {existing?.hasSecret && <span className="text-status-online">• set</span>}
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

// ── Members: attributes + ReBAC grants ──────────────────────────────────────

interface MemberEntry {
  id: string;
  role: string;
  user: { id: string; name: string | null; email: string | null };
  attributes: Record<string, unknown>;
}

function MembersTab(): React.JSX.Element {
  const trpc = useTRPC();
  const members = useQuery(trpc.members.list.queryOptions());
  const grants = useQuery(trpc.members.listGrants.queryOptions());

  return (
    <div className="grid gap-6">
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Member attributes</CardTitle>
          <CardDescription>
            Attributes feed ABAC policies (e.g. <code>team</code>, <code>onCall</code>). Edit the
            JSON bag per member.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="mono-label">Member</TableHead>
                <TableHead className="mono-label">Role</TableHead>
                <TableHead className="mono-label">Attributes</TableHead>
                <TableHead className="mono-label text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(members.data ?? []).map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.user.email ?? m.user.name ?? m.id}</TableCell>
                  <TableCell>
                    <Badge variant="muted">{m.role}</Badge>
                  </TableCell>
                  <TableCell className="mono-data text-xs">
                    {Object.keys(m.attributes).length ? JSON.stringify(m.attributes) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <AttributesEditor member={m as MemberEntry} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="card-pop border-0">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Resource grants (ReBAC)</CardTitle>
            <CardDescription>
              Grant a member or team an owner/operator/viewer relation on a specific resource.
            </CardDescription>
          </div>
          <GrantEditor />
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="mono-label">Principal</TableHead>
                <TableHead className="mono-label">Relation</TableHead>
                <TableHead className="mono-label">Resource</TableHead>
                <TableHead className="mono-label text-right">Remove</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(grants.data ?? []).map((g) => (
                <GrantRow key={g.id} grant={g} />
              ))}
              {grants.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-8 text-center text-sm">
                    No grants — access falls back to roles + policies.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function AttributesEditor({ member }: { member: MemberEntry }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState(JSON.stringify(member.attributes, null, 2));

  const save = useMutation(
    trpc.members.setAttributes.mutationOptions({
      onSuccess: () => {
        toast.success('Attributes saved');
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attributes — {member.user.email ?? member.id}</DialogTitle>
          <DialogDescription>JSON object. e.g. {`{ "team": "payments", "onCall": true }`}</DialogDescription>
        </DialogHeader>
        <Textarea
          className="font-mono text-xs"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          disabled={save.isPending}
          onClick={() => {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(text);
            } catch {
              toast.error('Attributes must be valid JSON');
              return;
            }
            save.mutate({ memberId: member.id, attributes: parsed });
          }}
        >
          Save
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function GrantRow({
  grant,
}: {
  grant: {
    id: string;
    principalType: string;
    principalId: string;
    resourceType: string;
    resourceId: string;
    relation: string;
  };
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const del = useMutation(
    trpc.members.deleteGrant.mutationOptions({
      onSuccess: () => {
        toast.success('Grant removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <TableRow>
      <TableCell className="mono-data text-xs">
        {grant.principalType}:{grant.principalId}
      </TableCell>
      <TableCell>
        <Badge variant="success">{grant.relation}</Badge>
      </TableCell>
      <TableCell className="mono-data text-xs">
        {grant.resourceType}:{grant.resourceId}
      </TableCell>
      <TableCell className="text-right">
        <Button variant="ghost" size="sm" onClick={() => del.mutate({ id: grant.id })}>
          <Trash2Icon className="size-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function GrantEditor(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [principalType, setPrincipalType] = React.useState<'member' | 'team'>('member');
  const [principalId, setPrincipalId] = React.useState('');
  const [resourceType, setResourceType] = React.useState<'node' | 'service' | 'stack'>('service');
  const [resourceId, setResourceId] = React.useState('');
  const [relation, setRelation] = React.useState<'owner' | 'operator' | 'viewer'>('operator');

  const create = useMutation(
    trpc.members.createGrant.mutationOptions({
      onSuccess: () => {
        toast.success('Grant created');
        setOpen(false);
        setPrincipalId('');
        setResourceId('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New grant</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New resource grant</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="mono-label">Principal type</Label>
              <Select value={principalType} onValueChange={(v) => setPrincipalType(v as 'member' | 'team')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member</SelectItem>
                  <SelectItem value="team">team</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Principal id</Label>
              <Input value={principalId} onChange={(e) => setPrincipalId(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="mono-label">Resource type</Label>
              <Select value={resourceType} onValueChange={(v) => setResourceType(v as typeof resourceType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="node">node</SelectItem>
                  <SelectItem value="service">service</SelectItem>
                  <SelectItem value="stack">stack</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Resource id</Label>
              <Input value={resourceId} onChange={(e) => setResourceId(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Relation</Label>
            <Select value={relation} onValueChange={(v) => setRelation(v as typeof relation)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">owner</SelectItem>
                <SelectItem value="operator">operator</SelectItem>
                <SelectItem value="viewer">viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            disabled={create.isPending || !principalId || !resourceId}
            onClick={() => create.mutate({ principalType, principalId, resourceType, resourceId, relation })}
          >
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Policies: editor (builder + JSON) + simulator ───────────────────────────

function PoliciesTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policies = useQuery(trpc.policies.list.queryOptions());

  const del = useMutation(
    trpc.policies.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Policy deleted');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="grid gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <PolicyBuilder />
        <PolicySimulator />
      </div>

      <Card className="card-pop border-0">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="mono-label">Name</TableHead>
                <TableHead className="mono-label">Effect</TableHead>
                <TableHead className="mono-label">Priority</TableHead>
                <TableHead className="mono-label">Status</TableHead>
                <TableHead className="mono-label text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(policies.data ?? []).map((p) => (
                <TableRow key={p.id} className="hover:bg-accent/60 transition-colors">
                  <TableCell className="font-medium">
                    {p.name}
                    {p.isDefault && (
                      <Badge variant="muted" className="ml-2">
                        default
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.effect === 'permit' ? 'success' : 'destructive'}>
                      {p.effect}
                    </Badge>
                  </TableCell>
                  <TableCell className="mono-data">{p.priority}</TableCell>
                  <TableCell>
                    <Badge variant={p.enabled ? 'success' : 'muted'}>
                      {p.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {!p.isDefault && (
                      <Button variant="ghost" size="sm" onClick={() => del.mutate({ id: p.id })}>
                        <Trash2Icon className="size-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {policies.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-10 text-center text-sm">
                    No policies yet — defaults keep today&apos;s roles in force.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function PolicyBuilder(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const actions = useQuery(trpc.policies.listActions.queryOptions());

  const [name, setName] = React.useState('');
  const [effect, setEffect] = React.useState<'permit' | 'forbid'>('permit');
  // No-code builder fields.
  const [action, setAction] = React.useState('service.restart');
  const [role, setRole] = React.useState('member');
  const [labelsText, setLabelsText] = React.useState('');
  const [relation, setRelation] = React.useState('');
  // Generated/editable JSON source.
  const [source, setSource] = React.useState(
    '{\n  "roles": ["member"],\n  "actions": ["service.restart"]\n}',
  );

  const validate = useQuery(trpc.policies.validate.queryOptions({ source }));

  const buildFromFields = () => {
    const doc: Record<string, unknown> = { actions: [action] };
    if (role) doc.roles = [role];
    if (relation) doc.relations = [relation];
    if (labelsText.trim()) {
      try {
        doc.resourceLabels = JSON.parse(labelsText);
      } catch {
        toast.error('Resource labels must be valid JSON');
        return;
      }
    }
    setSource(JSON.stringify(doc, null, 2));
  };

  const set = useMutation(
    trpc.policies.set.mutationOptions({
      onSuccess: () => {
        setName('');
        toast.success('Policy saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">New policy</CardTitle>
        <CardDescription>
          Build a rule, or edit the JSON directly. Defaults already reproduce owner/admin/member.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-[10rem] flex-1 gap-1.5">
            <Label className="mono-label">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="On-call may restart" />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Effect</Label>
            <Select value={effect} onValueChange={(v) => setEffect(v as 'permit' | 'forbid')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="permit">permit</SelectItem>
                <SelectItem value="forbid">forbid</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Action</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(actions.data ?? []).map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Role (optional)</Label>
            <Select value={role || 'none'} onValueChange={(v) => setRole(v === 'none' ? '' : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— any —</SelectItem>
                <SelectItem value="owner">owner</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
                <SelectItem value="member">member</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Relation (optional)</Label>
            <Select value={relation || 'none'} onValueChange={(v) => setRelation(v === 'none' ? '' : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                <SelectItem value="owner">owner</SelectItem>
                <SelectItem value="operator">operator</SelectItem>
                <SelectItem value="viewer">viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Resource labels (JSON)</Label>
            <Input
              value={labelsText}
              placeholder='{"env":"staging"}'
              onChange={(e) => setLabelsText(e.target.value)}
            />
          </div>
        </div>
        <Button variant="outline" className="w-fit" onClick={buildFromFields}>
          Generate JSON ↓
        </Button>

        <div className="grid gap-1.5">
          <Label className="mono-label">
            Rule (JSON){' '}
            {validate.data &&
              (validate.data.valid ? (
                <span className="text-status-online">• valid</span>
              ) : (
                <span className="text-destructive">• {validate.data.error}</span>
              ))}
          </Label>
          <Textarea
            className="font-mono text-xs"
            rows={6}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </div>
        <Button
          className="w-fit"
          disabled={set.isPending || !name || validate.data?.valid === false}
          onClick={() => set.mutate({ name, effect, source })}
        >
          Save policy
        </Button>
      </CardContent>
    </Card>
  );
}

function PolicySimulator(): React.JSX.Element {
  const trpc = useTRPC();
  const actions = useQuery(trpc.policies.listActions.queryOptions());
  const [action, setAction] = React.useState('service.restart');
  const [resourceType, setResourceType] = React.useState<'' | 'node' | 'service' | 'stack'>('');
  const [resourceId, setResourceId] = React.useState('');

  const sim = useQuery(
    trpc.policies.simulate.queryOptions(
      {
        action,
        ...(resourceType ? { resourceType } : {}),
        ...(resourceId ? { resourceId } : {}),
      },
      { enabled: false },
    ),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Simulator</CardTitle>
        <CardDescription>
          &ldquo;Can I do this?&rdquo; — runs the live decision path for your identity.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-1.5">
          <Label className="mono-label">Action</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(actions.data ?? []).map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Resource type</Label>
            <Select
              value={resourceType || 'none'}
              onValueChange={(v) => setResourceType(v === 'none' ? '' : (v as 'node' | 'service' | 'stack'))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                <SelectItem value="node">node</SelectItem>
                <SelectItem value="service">service</SelectItem>
                <SelectItem value="stack">stack</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Resource id</Label>
            <Input value={resourceId} onChange={(e) => setResourceId(e.target.value)} />
          </div>
        </div>
        <Button className="w-fit" onClick={() => void sim.refetch()} disabled={sim.isFetching}>
          <PlayIcon className="size-4" /> Run
        </Button>
        {sim.data && (
          <div className="grid gap-1.5">
            <Badge variant={sim.data.decision === 'permit' ? 'success' : 'destructive'} className="w-fit">
              {sim.data.decision}
            </Badge>
            <p className="text-muted-foreground text-xs">
              {sim.data.reasons.join('; ')}
              {sim.data.policyId ? ` (policy ${sim.data.policyId})` : ''}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
