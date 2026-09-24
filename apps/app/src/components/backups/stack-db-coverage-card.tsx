import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, DatabaseIcon, TriangleAlertIcon } from 'lucide-react';
import { Badge, Card, CardContent } from '@swarmy/ui';
import { relativeTime, untilTime } from './backup-format';
import { AutoBackupBadge } from './auto-backup-badge';
import { AppDbDumps } from './appdb-dumps';

/** `backups.autoCoverage` — one detected database and how it is covered. */
export interface CoverageDb {
  kind: 'managed' | 'compose';
  name: string;
  engine: string;
  volume: string | null;
  status: 'auto' | 'user' | 'opted-out' | 'unscheduled';
  method: string;
  retentionDays: number | null;
  nextRunAt: string | null;
  /** Compose MySQL/MariaDB/Mongo/Redis/Valkey: the logical dump beside the volume copy. */
  logical?: {
    mode: 'logical' | 'volume-only';
    method: string;
    note: string | null;
    lastAt: string | null;
    lastStatus: 'succeeded' | 'failed' | null;
    lastError: string | null;
  } | null;
}

export interface Coverage {
  destination: { id: string; name: string } | null;
  databases: CoverageDb[];
}

interface StackDbCoverageCardProps {
  stack: string;
  coverage: Coverage;
  /** Compose DB "change": open the schedule form prefilled with the volume. */
  onChangeVolume: (volume: string) => void;
}

/**
 * This stack's databases and how default-on backups cover each: managed
 * Postgres gets a nightly logical dump (pg_dump); a compose database gets a
 * nightly copy of its data volume, which is crash-consistent (like pulling the
 * plug — the engine recovers on start, but it is not a transactional dump).
 */
export function StackDbCoverageCard({
  stack,
  coverage,
  onChangeVolume,
}: StackDbCoverageCardProps): React.JSX.Element | null {
  if (coverage.databases.length === 0) return null;
  const off = coverage.destination == null;
  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <span className="mono-label">Databases</span>
          <span className="text-muted-foreground mono-label">
            {off ? 'no destination' : `→ ${coverage.destination?.name}`}
          </span>
        </div>
        {off && (
          <div className="bg-status-warning/10 text-status-warning flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3 text-sm">
            <span className="inline-flex items-center gap-2 font-medium">
              <TriangleAlertIcon className="size-4" /> Backups are off — add a destination
            </span>
            <Link to="/backups" className="flex items-center gap-1 font-bold hover:underline">
              Add a destination <ArrowRightIcon className="size-4" />
            </Link>
          </div>
        )}
        <div className="divide-border divide-y border-t">
          {coverage.databases.map((db) => (
            <CoverageRow key={`${db.kind}:${db.name}`} stack={stack} db={db} onChangeVolume={onChangeVolume} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CoverageRow({
  stack,
  db,
  onChangeVolume,
}: {
  stack: string;
  db: CoverageDb;
  onChangeVolume: (volume: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const logical = db.logical ?? null;
  return (
    <div className="grid gap-2 px-6 py-3">
      <div className="flex flex-wrap items-center gap-4">
        <DatabaseIcon className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="mono-data truncate font-medium">{db.name}</p>
          <p className="text-muted-foreground mono-label truncate">
            {db.engine} ·{' '}
            {db.method === 'volume'
              ? logical?.mode === 'logical'
                ? `logical dump (${logical.method}) + volume ${db.volume}`
                : `volume ${db.volume} (crash-consistent)`
              : `logical dump (${db.method})`}
            {db.nextRunAt ? ` · next ${untilTime(db.nextRunAt)}` : ''}
          </p>
          {logical?.mode === 'volume-only' && logical.note && (
            <p className="text-status-warning inline-flex items-center gap-1.5 text-xs">
              <TriangleAlertIcon className="size-3.5" /> {logical.note}
            </p>
          )}
          {logical?.mode === 'logical' && logical.lastStatus === 'failed' && (
            <p className="text-status-offline text-xs">
              Last dump failed {relativeTime(logical.lastAt)}: {logical.lastError ?? 'unknown error'} — the volume copy still ran.
            </p>
          )}
          {logical?.mode === 'logical' && logical.lastStatus === 'succeeded' && (
            <p className="text-muted-foreground text-xs">Last dump {relativeTime(logical.lastAt)}</p>
          )}
        </div>
        {logical?.mode === 'logical' && (
          <button
            type="button"
            className="text-primary text-xs font-bold hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide dumps' : 'Dumps & restore'}
          </button>
        )}
        <CoverageStatus stack={stack} db={db} onChangeVolume={onChangeVolume} />
      </div>
      {open && <AppDbDumps stack={stack} service={db.name} engine={db.engine} />}
    </div>
  );
}

function CoverageStatus({
  stack,
  db,
  onChangeVolume,
}: {
  stack: string;
  db: CoverageDb;
  onChangeVolume: (volume: string) => void;
}): React.JSX.Element {
  if (db.status === 'auto') {
    const change =
      db.kind === 'managed' ? (
        <Link
          to="/stacks/$name/data"
          params={{ name: stack }}
          className="text-primary text-xs font-bold hover:underline"
        >
          (change)
        </Link>
      ) : (
        <button
          type="button"
          className="text-primary text-xs font-bold hover:underline"
          onClick={() => db.volume && onChangeVolume(db.volume)}
        >
          (change)
        </button>
      );
    return <AutoBackupBadge retentionDays={db.retentionDays} change={change} />;
  }
  if (db.status === 'user') return <Badge variant="success">Scheduled</Badge>;
  if (db.status === 'opted-out') return <Badge variant="muted">Opted out</Badge>;
  return <Badge variant="warning">Not backed up</Badge>;
}
