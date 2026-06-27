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
  Switch,
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

export const Route = createFileRoute('/_authed/settings/api-keys')({
  component: ApiKeysPage,
});

function curlExample(prefix: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `curl -H "Authorization: Bearer ${prefix}…" ${origin}/api/v1/services`;
}

function ApiKeysPage(): React.JSX.Element {
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

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="API keys"
        title={
          <>
            Make swarmy <em>programmable</em>.
          </>
        }
        description="Mint an org-scoped key for the public REST API, the SDKs, or the Terraform provider. Read the docs at /api/v1/docs."
      />

      <div className="grid gap-6">
        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="text-base">New API key</CardTitle>
            <CardDescription>
              Keys carry the permissions of their creator and are scoped to this org. The secret is
              shown <strong>once</strong> — store it in a secret manager or CI variable.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4">
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
            <div className="flex items-center gap-2 pb-2">
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
          </CardContent>
        </Card>

        {issued && (
          <Alert className="ink-block border-0">
            <KeyRoundIcon className="size-4" />
            <AlertTitle className="font-bold">Copy it now — this key won't be shown again.</AlertTitle>
            <AlertDescription className="text-ink-foreground/70">
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
                  {issued}
                </code>
                <CopyButton value={issued} label="Copy" />
              </div>
              <p className="mt-4 mb-1 text-xs font-medium">Use it from anywhere:</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
                  {curlExample(issued)}
                </code>
                <CopyButton value={curlExample(issued)} label="Copy" />
              </div>
            </AlertDescription>
          </Alert>
        )}

        <Card className="card-pop border-0">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="mono-label">Name</TableHead>
                  <TableHead className="mono-label">Prefix</TableHead>
                  <TableHead className="mono-label">Scopes</TableHead>
                  <TableHead className="mono-label">Last used</TableHead>
                  <TableHead className="mono-label">Status</TableHead>
                  <TableHead className="mono-label">Created</TableHead>
                  <TableHead className="mono-label text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(keys.data ?? []).map((k) => (
                  <TableRow key={k.id} className="hover:bg-accent/60 transition-colors">
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell className="mono-data text-xs">swk_{k.prefix}…</TableCell>
                    <TableCell className="mono-data text-xs">{k.scopes.join(', ')}</TableCell>
                    <TableCell className="text-muted-foreground mono-data text-xs">
                      {k.lastUsedAt ? relTime(k.lastUsedAt) : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={k.status === 'active' ? 'success' : 'muted'}>{k.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground mono-data text-xs">
                      {relTime(k.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {k.status === 'active' && (
                        <Button variant="ghost" size="sm" onClick={() => revoke.mutate({ id: k.id })}>
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {keys.data?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-muted-foreground py-10 text-center text-sm">
                      No API keys yet. Mint one above to automate swarmy from curl, an SDK, or
                      Terraform.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
