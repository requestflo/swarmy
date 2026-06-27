import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchIcon, HammerIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
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
  StatusBadge,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';

export const Route = createFileRoute('/_authed/ci')({
  component: CiPage,
});

const STATUS_TONE: Record<string, 'online' | 'progress' | 'offline' | 'neutral'> = {
  succeeded: 'online',
  building: 'progress',
  pushing: 'progress',
  queued: 'progress',
  failed: 'offline',
  canceled: 'neutral',
};

function CiPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const repos = useQuery(trpc.cicd.listRepos.queryOptions());
  const builds = useQuery({ ...trpc.cicd.listBuilds.queryOptions({}), refetchInterval: 5000 });
  const registry = useQuery(trpc.cicd.getRegistryConfig.queryOptions());
  const gc = useQuery(trpc.cicd.getGcPolicy.queryOptions());

  const invalidate = () => qc.invalidateQueries();
  const removeRepo = useMutation(
    trpc.cicd.removeRepo.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const triggerBuild = useMutation(
    trpc.cicd.triggerBuild.mutationOptions({
      onSuccess: () => {
        toast.success('Build started');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setRegistry = useMutation(
    trpc.cicd.setRegistryEnabled.mutationOptions({
      onSuccess: () => {
        toast.success('Registry updated');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const repoCount = repos.data?.length ?? 0;
  const buildCount = builds.data?.length ?? 0;
  const regOnline = !!registry.data?.online;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="CI / CD"
        title={
          repoCount > 0 ? (
            <>
              <CountUp value={repoCount} /> repo{repoCount === 1 ? '' : 's'} <em>wired</em>.
            </>
          ) : (
            <>
              Push to <em>deploy</em>.
            </>
          )
        }
        description="Link a repo, build on your nodes, push to a registry that lives inside the swarm. No external CI."
        actions={<AddRepoDialog onDone={invalidate} />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Registry */}
        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              In-swarm registry
              <StatusBadge tone={regOnline ? 'online' : 'neutral'} label={regOnline ? 'Live' : 'Off'} />
            </CardTitle>
            <CardDescription>
              A single-replica <span className="mono-data">registry:2</span> on the{' '}
              <span className="mono-data">swarmy</span> overlay. Every node pulls over the network — never public.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
              <div>
                <Label className="font-medium">Enabled</Label>
                <p className="text-muted-foreground text-xs">
                  {registry.data?.host ? (
                    <span className="mono-data">{registry.data.host}</span>
                  ) : (
                    'Deploys one swarm service swarmy manages.'
                  )}
                </p>
              </div>
              <Switch
                checked={!!registry.data?.enabled}
                onCheckedChange={(v) => setRegistry.mutate({ enabled: v })}
              />
            </div>
          </CardContent>
        </Card>

        {/* GC policy */}
        <GcPolicyCard
          value={gc.data}
          onDone={() => qc.invalidateQueries({ queryKey: trpc.cicd.getGcPolicy.queryKey() })}
        />
      </div>

      {/* Repos */}
      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="text-base">Repositories</CardTitle>
          <CardDescription>Watched git repos. Build a ref by hand or let autodeploy redeploy on build.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-t">
            {(repos.data ?? []).map((r) => (
              <div
                key={r.id}
                className="hover:bg-accent/60 flex items-center gap-4 border-b px-6 py-3 transition-colors last:border-b-0"
              >
                <GitBranchIcon className="text-muted-foreground size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="mono-data truncate font-medium">{r.url}</p>
                  <p className="text-muted-foreground mono-label">
                    {r.provider} · {r.branch}
                    {r.autodeploy ? ' · autodeploy' : ''}
                    {r.hasToken ? ' · token' : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => triggerBuild.mutate({ repoId: r.id })}
                  disabled={triggerBuild.isPending}
                >
                  <HammerIcon className="size-4" /> Build
                </Button>
                <Button variant="ghost" size="icon" onClick={() => removeRepo.mutate({ id: r.id })}>
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            ))}
            {repoCount === 0 && (
              <div className="text-muted-foreground px-6 py-12 text-center text-sm">
                No repos yet. Link one to build &amp; deploy from a <span className="mono-data">git push</span>.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Builds */}
      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="text-base">Builds</CardTitle>
          <CardDescription>Most recent {buildCount} build{buildCount === 1 ? '' : 's'}.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-[1fr_auto] gap-x-4 px-6 pb-2 sm:grid-cols-[2fr_1fr_1.5fr_auto]">
            <span className="mono-label">Repo / image</span>
            <span className="mono-label hidden sm:block">Ref</span>
            <span className="mono-label hidden sm:block">Started</span>
            <span className="mono-label text-right">Status</span>
          </div>
          <div className="border-t">
            {(builds.data ?? []).map((b) => (
              <div
                key={b.id}
                className="hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0 sm:grid-cols-[2fr_1fr_1.5fr_auto]"
              >
                <div className="min-w-0">
                  <p className="mono-data truncate font-medium">{b.image ?? b.repoUrl}</p>
                  <p className="text-muted-foreground mono-label truncate sm:hidden">
                    {b.commit} · {b.status}
                  </p>
                </div>
                <span className="mono-data hidden truncate sm:block">{b.commit}</span>
                <span className="text-muted-foreground hidden text-xs sm:block">
                  {b.startedAt ? new Date(b.startedAt).toLocaleString() : '—'}
                </span>
                <div className="text-right">
                  <Badge variant="muted">
                    <span className={toneText(b.status)}>{b.status}</span>
                  </Badge>
                </div>
              </div>
            ))}
            {buildCount === 0 && (
              <div className="text-muted-foreground px-6 py-12 text-center text-sm">
                No builds yet. Trigger one from a repo above.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function toneText(status: string): string {
  const tone = STATUS_TONE[status] ?? 'neutral';
  return {
    online: 'text-status-online',
    progress: 'text-status-progress',
    offline: 'text-status-offline',
    neutral: 'text-muted-foreground',
  }[tone];
}

function GcPolicyCard({
  value,
  onDone,
}: {
  value: { mode: 'on-healthcheck' | 'age-days'; keepProd: boolean; days: number | null } | undefined;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const [mode, setMode] = React.useState<'on-healthcheck' | 'age-days'>(value?.mode ?? 'on-healthcheck');
  const [keepProd, setKeepProd] = React.useState(value?.keepProd ?? true);
  const [days, setDays] = React.useState(value?.days ?? 14);

  React.useEffect(() => {
    if (value) {
      setMode(value.mode);
      setKeepProd(value.keepProd);
      setDays(value.days ?? 14);
    }
  }, [value]);

  const save = useMutation(
    trpc.cicd.setGcPolicy.mutationOptions({
      onSuccess: () => {
        toast.success('GC policy saved');
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Image GC</CardTitle>
        <CardDescription>Reclaim disk — but never delete a digest that's running in prod.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label className="mono-label">Mode</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as 'on-healthcheck' | 'age-days')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on-healthcheck">Promote on healthcheck</SelectItem>
              <SelectItem value="age-days">Older than N days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {mode === 'age-days' && (
          <div className="grid gap-1.5">
            <Label className="mono-label">Keep days</Label>
            <Input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </div>
        )}
        <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
          <div>
            <Label className="font-medium">Keep prod images</Label>
            <p className="text-muted-foreground text-xs">Pin every digest running in prod. Recommended.</p>
          </div>
          <Switch checked={keepProd} onCheckedChange={setKeepProd} />
        </div>
        <Button
          onClick={() => save.mutate({ mode, keepProd, days: mode === 'age-days' ? days : null })}
          disabled={save.isPending}
        >
          Save policy
        </Button>
      </CardContent>
    </Card>
  );
}

function AddRepoDialog({ onDone }: { onDone: () => void }) {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const [provider, setProvider] = React.useState<'github' | 'gitlab'>('github');
  const [url, setUrl] = React.useState('');
  const [branch, setBranch] = React.useState('main');
  const [token, setToken] = React.useState('');
  const [autodeploy, setAutodeploy] = React.useState(false);

  const add = useMutation(
    trpc.cicd.addRepo.mutationOptions({
      onSuccess: () => {
        toast.success('Repo linked');
        setOpen(false);
        setUrl('');
        setToken('');
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="size-4" /> Add repo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link a repository</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as 'github' | 'gitlab')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="github">GitHub</SelectItem>
                <SelectItem value="gitlab">GitLab</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Repository URL</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Branch</Label>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Access token (encrypted at rest)</Label>
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… / glpat-…" />
          </div>
          <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
            <Label className="font-medium">Autodeploy on build</Label>
            <Switch checked={autodeploy} onCheckedChange={setAutodeploy} />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() =>
              add.mutate({ provider, url, branch, token: token || undefined, autodeploy })
            }
            disabled={add.isPending || !url}
          >
            Link repo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
