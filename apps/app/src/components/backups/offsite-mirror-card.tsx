import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, CloudIcon, PencilIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  StatusBadge,
  toast,
  type StatusTone,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { fmtBytes, relativeTime, untilTime } from './backup-format';
import { MIRROR_SCHEDULES, OffsiteMirrorForm } from './offsite-mirror-form';
import { RestoreOffsiteConfirm } from './restore-offsite-confirm';

interface RunView {
  id: string;
  direction: 'mirror' | 'restore';
  trigger: 'schedule' | 'manual';
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  objectsCopied: number;
  bytesCopied: string;
  errorCount: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const RUN_TONE: Record<RunView['status'], StatusTone> = {
  RUNNING: 'progress',
  SUCCEEDED: 'online',
  FAILED: 'offline',
};

function scheduleLabel(minutes: number): string {
  return (
    MIRROR_SCHEDULES.find((s) => s.value === minutes)?.label ??
    (minutes % 60 === 0 ? `Every ${minutes / 60}h` : `Every ${minutes}m`)
  );
}

/**
 * Offsite mirror: swarmy's object store (backups, edge certs, app buckets)
 * copied to an S3 destination outside the cluster — plus the way back.
 */
export function OffsiteMirrorCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const view = useQuery({
    ...trpc.offsiteMirror.get.queryOptions(),
    refetchInterval: (q) => (q.state.data?.running ? 5_000 : 30_000),
  });
  const mirrorNow = useMutation(
    trpc.offsiteMirror.mirrorNow.mutationOptions({
      onSuccess: () => {
        toast.success('Mirror started');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const data = view.data;
  const mirror = data?.mirror ?? null;
  const last = (data?.lastRun ?? null) as RunView | null;
  const running = Boolean(data?.running);
  const hasEligible = (data?.destinations ?? []).some((d) => d.eligible);

  const tone: StatusTone = !mirror
    ? 'warning'
    : running
      ? 'progress'
      : !mirror.enabled
        ? 'neutral'
        : last?.status === 'FAILED'
          ? 'offline'
          : data?.lastSuccessAt
            ? 'online'
            : 'progress';
  const badge = !mirror
    ? 'no off-site copy'
    : running
      ? last?.direction === 'restore'
        ? 'restoring'
        : 'mirroring'
      : !mirror.enabled
        ? 'paused'
        : last?.status === 'FAILED'
          ? 'last run failed'
          : data?.lastSuccessAt
            ? 'in sync'
            : 'first copy pending';

  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <Collapsible open={editing} onOpenChange={setEditing}>
          <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-5 pb-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="ink-block flex size-10 shrink-0 items-center justify-center rounded-xl">
                <CloudIcon className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="mono-label text-muted-foreground">Offsite mirror</p>
                <p className="headline mt-1 text-2xl">
                  {mirror ? (
                    <>
                      Mirrored to <em>{mirror.targetName || 'off-site'}</em>.
                    </>
                  ) : (
                    <>
                      Keep a copy <em>off-site</em>.
                    </>
                  )}
                </p>
                <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
                  {mirror
                    ? `${mirror.allBuckets ? 'Every bucket' : mirror.buckets.join(', ')} → ${mirror.root || 'destination'} · ${scheduleLabel(mirror.everyMinutes)} · ${mirror.mode === 'copy' ? 'copy (never deletes)' : `sync (deletes after ${mirror.graceDays}d)`}`
                    : 'Backups, edge certificates and app buckets live inside this cluster. Mirror them to Backblaze B2, Cloudflare R2, AWS S3, Wasabi — any S3 — so losing the cluster never loses them.'}
                </p>
              </div>
            </div>
            <StatusBadge tone={tone} label={badge} />
          </div>

          {mirror ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t px-6 py-4 lg:grid-cols-4">
              <Stat label="Last good copy" value={relativeTime(data?.lastSuccessAt ?? null)} />
              <Stat
                label="Last run copied"
                value={last ? fmtBytes(last.bytesCopied) : '—'}
                sub={last ? `${last.objectsCopied} object${last.objectsCopied === 1 ? '' : 's'}` : undefined}
              />
              <Stat label="Errors" value={last ? String(last.errorCount) : '—'} />
              <Stat label="Next run" value={mirror.enabled ? untilTime(mirror.nextRunAt) : 'paused'} />
            </div>
          ) : null}

          {last?.status === 'FAILED' && last.error ? (
            <div className="border-t px-6 py-3">
              <p className="text-status-offline text-sm">{last.error}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t px-6 py-4">
            {mirror ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full font-bold"
                  disabled={running || mirrorNow.isPending}
                  onClick={() => mirrorNow.mutate()}
                >
                  <ArrowUpFromLineIcon className="size-4" />
                  {running ? 'Running…' : 'Mirror now'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => setEditing((v) => !v)}
                >
                  <PencilIcon className="size-4" /> Edit
                </Button>
                <RestoreOffsiteConfirm targetName={mirror.targetName} disabled={running} />
              </>
            ) : (
              <Button
                size="sm"
                className="rounded-full font-bold"
                disabled={!hasEligible}
                onClick={() => setEditing(true)}
              >
                Set up the mirror
              </Button>
            )}
            {!mirror && !hasEligible ? (
              <span className="text-muted-foreground text-sm">
                Add an S3 destination outside the cluster first.
              </span>
            ) : null}
          </div>

          <CollapsibleContent>
            <OffsiteMirrorForm
              destinations={data?.destinations ?? []}
              initial={mirror}
              onDone={() => setEditing(false)}
            />
          </CollapsibleContent>

          {(data?.runs.length ?? 0) > 0 ? (
            <div className="border-t">
              <p className="mono-label text-muted-foreground px-6 pt-4 pb-2">Recent runs</p>
              <ul className="divide-y">
                {(data?.runs as RunView[]).map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </ul>
            </div>
          ) : null}
        </Collapsible>
      </CardContent>
    </Card>
  );
}

function RunRow({ run }: { run: RunView }): React.JSX.Element {
  const Icon = run.direction === 'restore' ? ArrowDownToLineIcon : ArrowUpFromLineIcon;
  return (
    <li className="hover:bg-accent/40 flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3 text-sm">
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="w-20 font-medium">{run.direction === 'restore' ? 'Restore' : 'Mirror'}</span>
      <StatusBadge
        tone={RUN_TONE[run.status]}
        label={run.status === 'RUNNING' ? 'running' : run.status === 'SUCCEEDED' ? 'done' : 'failed'}
      />
      <span className="mono-data">{fmtBytes(run.bytesCopied)}</span>
      <span className="mono-data text-muted-foreground">{run.objectsCopied} obj</span>
      {run.errorCount > 0 ? (
        <span className="mono-data text-status-offline">{run.errorCount} err</span>
      ) : null}
      <span className="text-muted-foreground ml-auto text-xs">
        {run.trigger === 'manual' ? 'manual · ' : ''}
        {relativeTime(run.startedAt)}
      </span>
      {run.status === 'FAILED' && run.error ? (
        <p className="text-status-offline basis-full truncate pl-8 text-xs" title={run.error}>
          {run.error}
        </p>
      ) : null}
    </li>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="mono-label text-muted-foreground">{label}</p>
      <p className="mono-data truncate text-lg font-semibold">{value}</p>
      {sub ? <p className="text-muted-foreground hidden text-xs sm:block">{sub}</p> : null}
    </div>
  );
}
