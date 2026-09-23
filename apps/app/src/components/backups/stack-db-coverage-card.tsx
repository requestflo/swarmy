import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, DatabaseIcon, TriangleAlertIcon } from 'lucide-react';
import { Badge, Card, CardContent } from '@swarmy/ui';
import { untilTime } from './backup-format';
import { AutoBackupBadge } from './auto-backup-badge';

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
            <div key={`${db.kind}:${db.name}`} className="flex flex-wrap items-center gap-4 px-6 py-3">
              <DatabaseIcon className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="mono-data truncate font-medium">{db.name}</p>
                <p className="text-muted-foreground mono-label truncate">
                  {db.engine} ·{' '}
                  {db.method === 'volume'
                    ? `volume ${db.volume} (crash-consistent)`
                    : `logical dump (${db.method})`}
                  {db.nextRunAt ? ` · next ${untilTime(db.nextRunAt)}` : ''}
                </p>
              </div>
              <CoverageStatus stack={stack} db={db} onChangeVolume={onChangeVolume} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
