import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  DatabaseBackupIcon,
  KeyRoundIcon,
  PlayIcon,
  ShieldCheckIcon,
  ServerIcon,
} from 'lucide-react';
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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { relTime } from '@/lib/format';

export const Route = createFileRoute('/_authed/settings/backup')({
  component: ControllerBackupPage,
});

function ControllerBackupPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Controller"
        title={
          <>
            Protect the <em>brain</em>.
          </>
        }
        description="The controller database is swarmy's control plane — orgs, nodes, join-token hashes, ingress, deployments. Back it up so a rebuilt controller can re-adopt the whole swarm."
      />
      <div className="grid gap-6">
        <DataStoreCard />
        <PassphraseCard />
        <ScheduleCard />
        <SnapshotsCard />
      </div>
    </div>
  );
}

// ── data store mode + managed-Postgres upgrade ──────────────────────────────

function DataStoreCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const summary = useQuery(trpc.system.dashboardSummary.queryOptions());
  const multiNode = (summary.data?.nodes.total ?? 0) > 1;

  const provision = useMutation(
    trpc.controllerBackup.provisionManagedPostgres.mutationOptions({
      onSuccess: (res) => {
        toast.success(`Managed Postgres deployed as "${res.serviceName}"`);
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ServerIcon className="size-4" /> Data store
        </CardTitle>
        <CardDescription>
          Lite mode runs an embedded Postgres (PGlite) inside the controller — zero dependencies,
          single node. Upgrade to a swarmy-managed Postgres when you go multi-node.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant="muted">Same Postgres dialect, one schema</Badge>
        {multiNode && (
          <span className="text-muted-foreground">
            You&apos;re multi-node — upgrading the controller database is recommended for reliability.
          </span>
        )}
        <Button
          variant={multiNode ? 'default' : 'outline'}
          size="sm"
          onClick={() => provision.mutate()}
          disabled={provision.isPending}
        >
          Upgrade to managed Postgres
        </Button>
      </CardContent>
      {provision.data && (
        <CardContent>
          <Alert>
            <AlertTitle className="font-bold">Managed Postgres is up. Finish the migrate:</AlertTitle>
            <AlertDescription>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
                {provision.data.steps.map((s: string, i: number) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </AlertDescription>
          </Alert>
        </CardContent>
      )}
    </Card>
  );
}

// ── restore passphrase (root of trust) ──────────────────────────────────────

function PassphraseCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.controllerBackup.getConfig.queryOptions());
  const [issued, setIssued] = React.useState<string | null>(null);
  const [stored, setStored] = React.useState(false);

  const generate = useMutation(
    trpc.controllerBackup.generatePassphrase.mutationOptions({
      onSuccess: (res) => {
        setIssued(res.passphrase);
        setStored(false);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const save = useMutation(
    trpc.controllerBackup.setPassphrase.mutationOptions({
      onSuccess: () => {
        toast.success('Restore passphrase saved');
        setIssued(null);
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const has = config.data?.hasPassphrase ?? false;

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRoundIcon className="size-4" /> Restore passphrase
        </CardTitle>
        <CardDescription>
          Controller backups are encrypted with a passphrase only you hold — separate from the
          server&apos;s keys, so restore works even when the controller is gone.{' '}
          <strong>Lose it and your backups are unrecoverable.</strong>
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="mono-label">Status</span>
          {has ? (
            <Badge variant="success">
              <ShieldCheckIcon className="mr-1 size-3" /> Captured ({config.data?.passphraseHint})
            </Badge>
          ) : (
            <Badge variant="muted">Not set</Badge>
          )}
        </div>

        {!issued && (
          <div>
            <Button size="sm" onClick={() => generate.mutate()} disabled={generate.isPending}>
              {has ? 'Rotate passphrase' : 'Generate passphrase'}
            </Button>
          </div>
        )}

        {issued && (
          <Alert className="ink-block border-0">
            <AlertTriangleIcon className="size-4" />
            <AlertTitle className="font-bold">Write this down now. It is shown once.</AlertTitle>
            <AlertDescription className="text-ink-foreground/70">
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-sm">
                  {issued}
                </code>
                <CopyButton value={issued} label="Copy" />
              </div>
              <label className="mt-4 flex items-center gap-2 text-xs">
                <Switch checked={stored} onCheckedChange={setStored} />
                I&apos;ve stored this passphrase in a password manager / recovery card.
              </label>
              <div className="mt-3">
                <Button
                  size="sm"
                  disabled={!stored || save.isPending}
                  onClick={() => save.mutate({ passphrase: issued })}
                >
                  Confirm &amp; save
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

// ── schedule + target + run-now ─────────────────────────────────────────────

function ScheduleCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.controllerBackup.getConfig.queryOptions());
  const targets = useQuery(trpc.backups.listTargets.queryOptions());

  const setConfig = useMutation(
    trpc.controllerBackup.setConfig.mutationOptions({
      onSuccess: () => qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const runNow = useMutation(
    trpc.controllerBackup.runNow.mutationOptions({
      onSuccess: () => {
        toast.success('Controller backup started');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const enabled = config.data?.enabled ?? false;
  const targetId = config.data?.targetId ?? '';
  const canRun = Boolean(targetId) && (config.data?.hasPassphrase ?? false);

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DatabaseBackupIcon className="size-4" /> Schedule
        </CardTitle>
        <CardDescription>
          Daily by default, kept 7d / 4w / 3m, stored to a backup target (shared with volume
          backups). Runs on the controller — secrets never leave it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-4 text-sm">
        <div className="flex items-center gap-2 pb-2">
          <Switch
            checked={enabled}
            onCheckedChange={(v) => setConfig.mutate({ enabled: v })}
            disabled={!canRun}
          />
          <Label className="mono-label">Enabled</Label>
        </div>
        <div className="grid min-w-[14rem] gap-1.5">
          <Label className="mono-label">Backup target</Label>
          <Select value={targetId} onValueChange={(v) => setConfig.mutate({ targetId: v })}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a target" />
            </SelectTrigger>
            <SelectContent>
              {(targets.data ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} ({t.kind})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={() => runNow.mutate()} disabled={!canRun || runNow.isPending}>
          <PlayIcon className="size-4" /> Back up now
        </Button>
        {!canRun && (
          <span className="text-muted-foreground pb-2 text-xs">
            Set a passphrase and pick a target to enable backups.
          </span>
        )}
      </CardContent>
    </Card>
  );
}

// ── snapshot history ─────────────────────────────────────────────────────────

function SnapshotsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const snapshots = useQuery(trpc.controllerBackup.listSnapshots.queryOptions());

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Snapshots</CardTitle>
        <CardDescription>
          Controller-state restore catalog. For total-loss recovery, use the standalone{' '}
          <code className="mono-data">bun run restore</code> CLI with your passphrase.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="mono-label">Taken</TableHead>
              <TableHead className="mono-label">Status</TableHead>
              <TableHead className="mono-label">Size</TableHead>
              <TableHead className="mono-label">restic id</TableHead>
              <TableHead className="mono-label">DB mode</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(snapshots.data ?? []).map((s) => (
              <TableRow key={s.id} className="hover:bg-accent/60 transition-colors">
                <TableCell className="mono-data text-xs">{relTime(s.startedAt)}</TableCell>
                <TableCell>
                  <Badge variant={s.status === 'SUCCEEDED' ? 'success' : s.status === 'FAILED' ? 'destructive' : 'muted'}>
                    {s.status}
                  </Badge>
                </TableCell>
                <TableCell className="mono-data text-xs">
                  {s.sizeBytes ? `${(Number(s.sizeBytes) / 1024 / 1024).toFixed(1)} MB` : '—'}
                </TableCell>
                <TableCell className="mono-data text-xs">{s.resticSnapshotId ?? '—'}</TableCell>
                <TableCell className="mono-data text-xs">{s.manifest?.dbDriver ?? '—'}</TableCell>
              </TableRow>
            ))}
            {snapshots.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-10 text-center text-sm">
                  No controller backups yet. Set a passphrase, pick a target, and back up now.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
