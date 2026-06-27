import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
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
  CopyButton,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { relTime } from '@/lib/format';

export const Route = createFileRoute('/_authed/settings')({
  component: SettingsPage,
});

function installOneLiner(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `curl -fsSL ${origin}/install.sh | SWARMY_JOIN_TOKEN=${token} sh`;
}

function SettingsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Settings"
        title={<>Run the <em>team</em>.</>}
        description="Your org, who's in it, and the tokens that let nodes join the swarm."
      />
      <Tabs defaultValue="tokens">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="tokens">Join tokens</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="mt-6">
          <GeneralTab />
        </TabsContent>
        <TabsContent value="members" className="mt-6">
          <MembersTab />
        </TabsContent>
        <TabsContent value="tokens" className="mt-6">
          <TokensTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function GeneralTab(): React.JSX.Element {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Organization</CardTitle>
        <CardDescription>Identity for your swarm. This is what nodes and members belong to.</CardDescription>
      </CardHeader>
      <CardContent className="grid max-w-sm gap-4 text-sm">
        <div className="grid gap-1.5">
          <Label className="mono-label">Name</Label>
          <Input value={org.data?.name ?? ''} readOnly />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Slug</Label>
          <Input value={org.data?.slug ?? ''} readOnly />
        </div>
        <div className="flex items-center gap-2">
          <span className="mono-label">Your role</span>
          <Badge variant="muted">{org.data?.role ?? '—'}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function MembersTab(): React.JSX.Element {
  const trpc = useTRPC();
  const members = useQuery(trpc.org.members.queryOptions());
  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="mono-label">Member</TableHead>
              <TableHead className="mono-label">Email</TableHead>
              <TableHead className="mono-label">Role</TableHead>
              <TableHead className="mono-label">Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(members.data ?? []).map((m) => (
              <TableRow key={m.id} className="hover:bg-accent/60 transition-colors">
                <TableCell className="font-medium">{m.user.name}</TableCell>
                <TableCell className="text-muted-foreground">{m.user.email}</TableCell>
                <TableCell>
                  <Badge variant="muted">{m.role}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground mono-data text-xs">{relTime(m.joinedAt)}</TableCell>
              </TableRow>
            ))}
            {members.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground py-10 text-center text-sm">
                  Just you so far. Invite the rest of the crew.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TokensTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const tokens = useQuery(trpc.nodes.listJoinTokens.queryOptions());
  const [issued, setIssued] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('');

  const generate = useMutation(
    trpc.nodes.generateJoinToken.mutationOptions({
      onSuccess: (res) => {
        setIssued(res.token);
        setLabel('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const revoke = useMutation(
    trpc.nodes.revokeJoinToken.mutationOptions({
      onSuccess: () => {
        toast.success('Token revoked');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="grid gap-6">
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Enroll a node</CardTitle>
          <CardDescription>
            Mint a join token, then run the agent on the node with{' '}
            <code className="bg-muted mono-data rounded px-1 py-0.5 text-xs">SWARMY_JOIN_TOKEN</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-[12rem] flex-1 gap-1.5">
            <Label htmlFor="token-label" className="mono-label">
              Label (optional)
            </Label>
            <Input id="token-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="prod-worker-1" />
          </div>
          <Button onClick={() => generate.mutate({ label: label || undefined })} disabled={generate.isPending}>
            <PlusIcon className="size-4" /> Generate
          </Button>
        </CardContent>
      </Card>

      {issued && (
        <Alert className="ink-block border-0">
          <KeyRoundIcon className="size-4" />
          <AlertTitle className="font-bold">Copy it now — this token won't be shown again.</AlertTitle>
          <AlertDescription className="text-ink-foreground/70">
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
                {issued}
              </code>
              <CopyButton value={issued} label="Copy" />
            </div>
            <p className="mt-4 mb-1 text-xs font-medium">Run this on any fresh Linux box:</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
                {installOneLiner(issued)}
              </code>
              <CopyButton value={installOneLiner(issued)} label="Copy" />
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Card className="card-pop border-0">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="mono-label">Label</TableHead>
                <TableHead className="mono-label">Prefix</TableHead>
                <TableHead className="mono-label">Uses</TableHead>
                <TableHead className="mono-label">Status</TableHead>
                <TableHead className="mono-label">Created</TableHead>
                <TableHead className="mono-label text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(tokens.data ?? []).map((t) => (
                <TableRow key={t.id} className="hover:bg-accent/60 transition-colors">
                  <TableCell className="font-medium">{t.label ?? '—'}</TableCell>
                  <TableCell className="mono-data text-xs">{t.tokenPrefix}…</TableCell>
                  <TableCell className="mono-data">
                    {t.usedCount}
                    {t.maxUses != null ? ` / ${t.maxUses}` : ''}
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.status === 'active' ? 'success' : 'muted'}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground mono-data text-xs">{relTime(t.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {t.status === 'active' && (
                      <Button variant="ghost" size="sm" onClick={() => revoke.mutate({ id: t.id })}>
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {tokens.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-10 text-center text-sm">
                    No tokens yet. Mint one above to bring your first node into the swarm.
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
