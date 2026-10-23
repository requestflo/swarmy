import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button, cn } from '@swarmy/ui';
import { TONE_DOT, Tech } from '@/components/calm';
import { cronWords } from '@/components/stack-data/pg-choices';
import { RunDrillDialog } from '@/components/resilience/run-drill-dialog';
import { formatDurationMs, formatDurationSec, relativeTime } from '@/components/resilience/format';
import type { PgBackupsData } from './use-pg-backups';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function Mini({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="calm-card flex min-w-0 flex-col items-start gap-1.5 px-4 py-3.5">
      <span className="calm-eyebrow text-muted-foreground">{eyebrow}</span>
      {children}
    </div>
  );
}

/** Where a destination lives, in one mono line. */
function whereLine(t: NonNullable<PgBackupsData['target']>): string {
  if (t.kind.toLowerCase() === 'node') return `on a server · ${t.bucket}`;
  const host = t.endpoint ? t.endpoint.replace(/^https?:\/\//, '') : 'S3';
  return `${host} · ${t.bucket}`;
}

/** Schedule · Goes to · Last drill: the three facts above a cluster's restore points. */
export function PgSummaryCards({ stack, cluster, b }: { stack: string; cluster: string; b: PgBackupsData }): React.JSX.Element {
  const s = b.schedule;
  const d = b.drill;
  const last = d?.last ?? null;
  const elsewhere = last?.target && last.target !== `${stack}/${cluster}` ? ` on ${last.target}` : '';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-3">
      <Mini eyebrow="Schedule">
        <b className="text-[15px] font-semibold">{s ? cap(cronWords(s.cron) ?? s.cron) : 'Not on a schedule'}</b>
        <span className="text-muted-foreground text-[13px] leading-snug">
          {!s ? 'Nothing saves this database on its own yet.' : s.pitr ? 'plus every change in between, so you can restore to any second' : 'a full copy each time'}
        </span>
        {s ? <Tech>cron {s.cron} · {s.engine}{s.pitr ? ' · WAL archive on' : ''}{s.auto ? ' · default-on' : ''}</Tech> : null}
        <Button asChild variant="outline" size="sm" className="mt-1 pointer-coarse:min-h-11">
          <Link to="/stacks/$name/data" params={{ name: stack }}>Change</Link>
        </Button>
      </Mini>
      <Mini eyebrow="Goes to">
        {b.target ? (
          <span className="flex max-w-full min-w-0 items-center gap-2 text-[14px]">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[b.target.enabled ? 'ok' : 'idle'])} />
            <b className="truncate font-semibold">{b.target.name}</b>
          </span>
        ) : (
          <b className="text-[15px] font-semibold">Nowhere yet</b>
        )}
        {b.target ? <span className="text-muted-foreground max-w-full truncate font-mono text-[11.5px]">{whereLine(b.target)}</span> : null}
        <Link to="/backups" className="text-primary mt-1 font-mono text-[11.5px] hover:underline">
          {b.target ? 'Manage destinations →' : 'Set up a destination →'}
        </Link>
      </Mini>
      <Mini eyebrow="Last drill">
        {!last ? (
          <>
            <b className="text-[15px] font-semibold">Never tried</b>
            <span className="text-muted-foreground text-[13px] leading-snug">A drill restores the latest save into a throwaway copy and checks it.</span>
          </>
        ) : last.status === 'failed' ? (
          <>
            <b className="text-tone-bad text-[15px] font-semibold">The last drill failed</b>
            <span className="text-muted-foreground text-[13px]">{relativeTime(last.at)}{elsewhere}</span>
          </>
        ) : (
          <>
            <b className="text-[15px] font-semibold">Restored in {formatDurationMs(d?.rtoEstimateMs ?? last.durationMs)}</b>
            <span className="text-muted-foreground text-[13px]">It answered · {relativeTime(last.at)}{elsewhere}</span>
          </>
        )}
        {d ? (
          <Tech>
            SELECT 1 {last ? (last.status === 'passed' ? '✓' : '✗') : '—'}
            {d.rpoSeconds != null ? ` · RPO ${formatDurationSec(d.rpoSeconds)}` : ''}
            {d.rtoEstimateMs != null ? ` · RTO ≈ ${formatDurationMs(d.rtoEstimateMs)}` : ''}
          </Tech>
        ) : null}
        <div className="mt-1">
          <RunDrillDialog
            kind="restore"
            targets={b.drillTargets}
            label="Run a drill"
            disabled={!d?.available || b.drillTargets.length === 0}
            disabledReason={d?.unavailableReason ?? (b.drillTargets.length === 0 ? `${cluster} isn’t running` : null)}
          />
        </div>
      </Mini>
    </div>
  );
}
