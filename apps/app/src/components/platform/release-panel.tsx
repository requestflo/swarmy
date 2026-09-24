import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, RefreshCwIcon, ShieldCheckIcon, ShieldAlertIcon, UploadIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Progress,
  Switch,
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { UpgradeTimeline } from './upgrade-timeline';
import { NOTE_VARIANT, STEP_TEXT, usePlatformStatus, when } from './use-platform';

const STEP_KEYS = Object.keys(STEP_TEXT);

/**
 * The story column + lanes of the Upgrade board: current → available, the
 * release notes, what will restart, the Upgrade button (preflight report →
 * confirm), then the live per-step timeline. The run keeps going with the tab
 * closed, and across the controller restarting itself.
 */
export function ReleasePanel({ admin }: { admin: boolean }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = usePlatformStatus();
  const done = { onSuccess: () => void qc.invalidateQueries(), onError: (e: { message: string }) => toast.error(e.message) };
  const check = useMutation(trpc.platform.check.mutationOptions({ ...done, onSuccess: () => { toast.success('Checked for updates'); void qc.invalidateQueries(); } }));
  const start = useMutation(trpc.platform.start.mutationOptions({ ...done, onSuccess: () => { toast.success('Upgrade started'); void qc.invalidateQueries(); } }));
  const retry = useMutation(trpc.platform.retry.mutationOptions(done));
  const cancel = useMutation(trpc.platform.cancel.mutationOptions(done));
  const [skipBackup, setSkipBackup] = React.useState(false);

  const v = q.data;
  if (!v) return null;
  const { release, run } = v;
  const av = release.available;
  const live = run?.status === 'running';
  const failed = run?.status === 'failed';
  const showRun = run && (live || failed || (run.finishedAt && Date.now() - new Date(run.finishedAt).getTime() < 24 * 3600_000));
  const pause = av?.migrations.some((m) => m.pause) ?? false;
  const pct = run ? Math.round((run.progress.done / run.progress.total) * 100) : 0;

  const title = live
    ? `Upgrading to ${run.toVersion}…`
    : av
      ? `${av.version} is ready.`
      : `You are on ${release.current.version}.`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {/* ── left: the story ── */}
      <section className="card-pop grid content-start gap-5 p-6" aria-label="Release">
        <div className="grid gap-1.5">
          <span className="mono-label text-muted-foreground">
            {release.policy.channel === 'edge' ? 'Edge channel · every main build' : 'Stable channel · tagged releases'}
          </span>
          <h2 className="text-3xl leading-tight font-bold tracking-tight">{title}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {live
              ? 'You can close this tab. The upgrade keeps going, even while swarmy restarts itself.'
              : 'Nothing changes until you press the button. We back everything up first, go one piece at a time, and roll back any piece that does not come up healthy.'}
          </p>
        </div>

        <div className="mono-data flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline">{release.current.version}</Badge>
          {av ? (
            <>
              <ArrowRightIcon className="text-muted-foreground size-4" aria-hidden />
              <Badge variant="default">{av.version}</Badge>
              {av.verified ? (
                <span className="text-status-online inline-flex items-center gap-1 text-xs">
                  <ShieldCheckIcon className="size-3.5" /> signed · verified
                </span>
              ) : (
                <span className="text-destructive inline-flex items-center gap-1 text-xs">
                  <ShieldAlertIcon className="size-3.5" /> unverified release
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground text-xs">up to date · checked {when(release.lastCheckAt)}</span>
          )}
        </div>
        {release.lastCheckError ? <p className="text-status-warning text-xs">Last check failed: {release.lastCheckError}</p> : null}

        {live ? (
          <div className="grid gap-2 rounded-xl border p-4">
            <span className="text-sm font-semibold">
              {STEP_TEXT[run.step]?.name ?? run.step} — {run.steps.find((s) => s.key === run.step)?.detail ?? 'in progress'}
            </span>
            <Progress value={pct} aria-label="Upgrade progress" />
            <span className="text-muted-foreground mono-data text-xs">
              step {Math.min(run.progress.done + 1, run.progress.total)} of {run.progress.total}
            </span>
          </div>
        ) : failed ? (
          <div className="border-destructive/40 grid gap-3 rounded-xl border p-4">
            <span className="text-sm font-semibold">The upgrade stopped at {STEP_TEXT[run.step]?.name ?? run.step}</span>
            <span className="text-muted-foreground text-xs">{run.error}</span>
            {admin ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => retry.mutate({ id: run.id })} disabled={retry.isPending}>
                  Retry from this step
                </Button>
                <Button size="sm" variant="outline" onClick={() => cancel.mutate({ id: run.id })} disabled={cancel.isPending}>
                  Dismiss
                </Button>
              </div>
            ) : null}
          </div>
        ) : av && admin ? (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="lg" disabled={Boolean(av.blocked) || start.isPending}>
                    Upgrade to {av.version}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Upgrade to {av.version}?</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="grid gap-2 text-sm">
                        <p>In this order, each one health-checked and rolled back on its own if it fails:</p>
                        <ol className="list-decimal space-y-1 pl-5">
                          {STEP_KEYS.map((k) => (
                            <li key={k}>
                              <b>{STEP_TEXT[k]!.name}</b> — {STEP_TEXT[k]!.what}
                            </li>
                          ))}
                        </ol>
                        {av.migrations.map((m) => (
                          <p key={m.id} className="text-status-warning">
                            {m.note}
                          </p>
                        ))}
                        <p>Apps keep serving throughout; the controller is unreachable for about a minute while it restarts.</p>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="flex items-center gap-2">
                    <Switch id="skip-backup" checked={skipBackup} onCheckedChange={setSkipBackup} />
                    <Label htmlFor="skip-backup" className="text-xs">
                      Upgrade without a fresh controller backup (not recommended)
                    </Label>
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Not now</AlertDialogCancel>
                    <AlertDialogAction onClick={() => start.mutate({ version: av.version, skipBackup })}>Start upgrade</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <span className="text-muted-foreground text-xs leading-snug">
                {av.blocked ?? (pause ? 'Includes a brief object-storage pause.' : 'Rolling — apps keep serving.')}
              </span>
            </div>
          </div>
        ) : null}

        {av?.notes.length ? (
          <div className="grid gap-2">
            <span className="mono-label text-muted-foreground">What changes</span>
            <ul className="grid max-h-64 gap-1.5 overflow-y-auto">
              {av.notes.map((n, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <Badge variant={NOTE_VARIANT[n.kind] ?? 'muted'} className="min-w-14">
                    {n.kind}
                  </Badge>
                  <span className="text-muted-foreground leading-snug">{n.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {admin ? (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button size="sm" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
              <RefreshCwIcon className="size-3.5" /> Check for updates
            </Button>
            <ImportReleaseButton />
          </div>
        ) : null}
      </section>

      {/* ── right: the lanes ── */}
      <section className="grid content-start gap-3" aria-label="Upgrade steps">
        <span className="mono-label text-muted-foreground">
          {showRun ? `Run ${run.fromVersion} → ${run.toVersion} · started ${when(run.startedAt)}` : 'In this order · each one health-checked, rolled back on its own if it fails'}
        </span>
        <UpgradeTimeline
          steps={showRun ? run.steps : STEP_KEYS.map((key) => ({ key, status: 'pending', detail: null, error: null }))}
          pauses={pause}
        />
        {showRun && run.log.length ? (
          <ol className="text-muted-foreground mono-data max-h-48 space-y-0.5 overflow-y-auto rounded-xl border p-3 text-xs">
            {run.log.slice(-20).map((l) => (
              <li key={l.at + l.msg}>
                {new Date(l.at).toLocaleTimeString()} — {l.msg}
              </li>
            ))}
          </ol>
        ) : null}
        {av?.components.some((c) => c.changed) ? (
          <details className="rounded-xl border p-3 text-xs">
            <summary className="cursor-pointer font-medium">Components in {av.version}</summary>
            <ul className="mono-data mt-2 grid gap-1">
              {av.components
                .filter((c) => c.changed)
                .map((c) => (
                  <li key={c.key} className="flex flex-wrap gap-2">
                    <span className="w-28 shrink-0 font-semibold">{c.key}</span>
                    <span className="text-muted-foreground break-all">
                      {c.image}
                      {c.tag ? `:${c.tag}` : ''} {c.digest ? `@${c.digest.slice(7, 19)}` : '(unresolved)'}
                    </span>
                  </li>
                ))}
            </ul>
          </details>
        ) : null}
      </section>
    </div>
  );
}

/** Offline bundle / air-gapped path: paste or load platform.json + platform.json.sig. */
function ImportReleaseButton(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [manifest, setManifest] = React.useState('');
  const [signature, setSignature] = React.useState('');
  const imp = useMutation(
    trpc.platform.importRelease.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Release ${r.manifest?.version ?? ''} imported and verified`);
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const load = (set: (s: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void f.text().then(set);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <UploadIcon className="size-3.5" /> Import release
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a release</DialogTitle>
          <DialogDescription>
            For clusters without internet access: the <span className="mono-data">platform.json</span> and{' '}
            <span className="mono-data">platform.json.sig</span> from an offline bundle. They are checked against the swarmy
            release key before anything is stored.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label className="mono-label">platform.json</Label>
          <input type="file" accept=".json,application/json" onChange={load(setManifest)} className="text-xs" />
          <Textarea rows={4} value={manifest} onChange={(e) => setManifest(e.target.value)} className="mono-data text-xs" />
          <Label className="mono-label">platform.json.sig</Label>
          <input type="file" onChange={load(setSignature)} className="text-xs" />
          <Textarea rows={2} value={signature} onChange={(e) => setSignature(e.target.value)} className="mono-data text-xs" />
        </div>
        <DialogFooter>
          <Button onClick={() => imp.mutate({ manifest, signature })} disabled={!manifest || !signature || imp.isPending}>
            Verify and import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
