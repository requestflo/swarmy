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

function SettingsPage() {
  return (
    <div>
      <PageHeader title="Settings" description="Manage your team, members, and node enrollment." />
      <Tabs defaultValue="tokens">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="tokens">Join tokens</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="mt-4">
          <GeneralTab />
        </TabsContent>
        <TabsContent value="members" className="mt-4">
          <MembersTab />
        </TabsContent>
        <TabsContent value="tokens" className="mt-4">
          <TokensTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function GeneralTab() {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organization</CardTitle>
      </CardHeader>
      <CardContent className="grid max-w-sm gap-3 text-sm">
        <div className="grid gap-1.5">
          <Label>Name</Label>
          <Input value={org.data?.name ?? ''} readOnly />
        </div>
        <div className="grid gap-1.5">
          <Label>Slug</Label>
          <Input value={org.data?.slug ?? ''} readOnly />
        </div>
        <div>
          Your role: <Badge variant="muted">{org.data?.role ?? '—'}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function MembersTab() {
  const trpc = useTRPC();
  const members = useQuery(trpc.org.members.queryOptions());
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(members.data ?? []).map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.user.name}</TableCell>
                <TableCell className="text-muted-foreground">{m.user.email}</TableCell>
                <TableCell>
                  <Badge variant="muted">{m.role}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">{relTime(m.joinedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TokensTab() {
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
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enroll a node</CardTitle>
          <CardDescription>
            Mint a join token, then run the agent on the node with{' '}
            <code className="bg-muted rounded px-1 py-0.5 text-xs">SWARMY_JOIN_TOKEN</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="token-label">Label (optional)</Label>
            <Input id="token-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="prod-worker-1" />
          </div>
          <Button onClick={() => generate.mutate({ label: label || undefined })} disabled={generate.isPending}>
            <PlusIcon className="size-4" /> Generate
          </Button>
        </CardContent>
      </Card>

      {issued && (
        <Alert>
          <KeyRoundIcon className="size-4" />
          <AlertTitle>Copy your token now — it won’t be shown again</AlertTitle>
          <AlertDescription>
            <div className="mt-2 flex items-center gap-2">
              <code className="bg-muted flex-1 overflow-x-auto rounded px-2 py-1 font-mono text-xs">
                {issued}
              </code>
              <CopyButton value={issued} label="Copy" />
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(tokens.data ?? []).map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.label ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{t.tokenPrefix}…</TableCell>
                  <TableCell>
                    {t.usedCount}
                    {t.maxUses != null ? ` / ${t.maxUses}` : ''}
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.status === 'active' ? 'success' : 'muted'}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{relTime(t.createdAt)}</TableCell>
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
                  <TableCell colSpan={6} className="text-muted-foreground py-8 text-center text-sm">
                    No tokens yet.
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
