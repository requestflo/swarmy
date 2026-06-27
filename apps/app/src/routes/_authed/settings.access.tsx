import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GithubIcon, ShieldCheckIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CopyButton,
  Input,
  Label,
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

export const Route = createFileRoute('/_authed/settings/access')({
  component: AccessPage,
});

function AccessPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Access"
        title={<>Who gets <em>in</em>, and what they can do.</>}
        description="Flip on sign-in providers and shape access with policies — live, no restart."
      />
      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">Sign-in providers</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="mt-6">
          <ProvidersTab />
        </TabsContent>
        <TabsContent value="policies" className="mt-6">
          <PoliciesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
};

function ProvidersTab(): React.JSX.Element {
  const trpc = useTRPC();
  const providers = useQuery(trpc.authConfig.listProviders.queryOptions());
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(providers.data ?? []).map((p) => (
        <ProviderCard key={p.type} provider={p} />
      ))}
      {providers.data?.length === 0 && (
        <p className="text-muted-foreground text-sm">No providers available.</p>
      )}
    </div>
  );
}

interface ProviderEntry {
  type: string;
  enabled: boolean;
  clientId: string | null;
  hasSecret: boolean;
  scopes: string[];
  callbackUrl: string;
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
            save.mutate({
              type: provider.type,
              clientId,
              clientSecret: clientSecret || undefined,
            })
          }
          disabled={save.isPending}
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function PoliciesTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policies = useQuery(trpc.policies.list.queryOptions());

  const [name, setName] = React.useState('');
  const [effect, setEffect] = React.useState<'permit' | 'forbid'>('permit');
  const [source, setSource] = React.useState(
    '{\n  "roles": ["member"],\n  "actions": ["service.restart"]\n}',
  );

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
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">New policy</CardTitle>
          <CardDescription>
            Policies layer over roles. The seeded defaults already reproduce
            owner/admin/member — add a rule only to diverge.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-[12rem] flex-1 gap-1.5">
              <Label className="mono-label">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="On-call may restart" />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Effect</Label>
              <select
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                value={effect}
                onChange={(e) => setEffect(e.target.value as 'permit' | 'forbid')}
              >
                <option value="permit">permit</option>
                <option value="forbid">forbid</option>
              </select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Rule (JSON)</Label>
            <Textarea
              className="font-mono text-xs"
              rows={6}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </div>
          <Button
            className="w-fit"
            disabled={set.isPending || !name}
            onClick={() => set.mutate({ name, effect, source })}
          >
            Save policy
          </Button>
        </CardContent>
      </Card>

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
                    No policies yet — defaults keep today's roles in force.
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
