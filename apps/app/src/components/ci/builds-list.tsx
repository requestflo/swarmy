import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { HammerIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  type StatusTone,
} from '@swarmy/ui';
import { CountUp } from '@/components/count-up';

interface BuildRow {
  id: string;
  repoUrl: string;
  commit: string | null;
  status: string;
  image: string | null;
  startedAt: string | null;
}

interface BuildsListProps {
  builds: BuildRow[];
}

const STATUS_TONE: Record<string, StatusTone> = {
  succeeded: 'online',
  building: 'progress',
  pushing: 'progress',
  queued: 'progress',
  failed: 'offline',
  canceled: 'neutral',
};

function buildTone(status: string): StatusTone {
  return STATUS_TONE[status] ?? 'neutral';
}

/** Flat build rows inside one card-pop. Each row links to its live log. */
export function BuildsList({ builds }: BuildsListProps): React.JSX.Element {
  const total = builds.length;
  const running = builds.filter((b) => buildTone(b.status) === 'progress').length;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Builds</CardTitle>
        <CardDescription>
          Most recent {total} build{total === 1 ? '' : 's'}.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {total === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<HammerIcon />}
              title="No builds yet"
              description="Trigger one from a repo above and watch the log stream in live."
            />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 px-6 py-4">
              <span className="mono-label">
                <CountUp value={total} /> recent
              </span>
              <span className="text-muted-foreground mono-label">{running} in flight</span>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-x-4 px-6 pb-2 sm:grid-cols-[2fr_1fr_1.5fr_auto]">
              <span className="mono-label">Repo / image</span>
              <span className="mono-label hidden sm:block">Ref</span>
              <span className="mono-label hidden sm:block">Started</span>
              <span className="mono-label text-right">Status</span>
            </div>
            <div className="divide-border divide-y border-t">
              {builds.map((b) => (
                <Link
                  key={b.id}
                  to="/ci/$buildId"
                  params={{ buildId: b.id }}
                  className="hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 px-6 py-4 transition-colors sm:grid-cols-[2fr_1fr_1.5fr_auto]"
                >
                  <div className="min-w-0">
                    <p className="mono-data truncate font-medium">{b.image ?? b.repoUrl}</p>
                    <p className="text-muted-foreground mono-label truncate sm:hidden">
                      {b.commit} · {b.status}
                    </p>
                  </div>
                  <span className="mono-data hidden truncate sm:block">{b.commit}</span>
                  <span className="text-muted-foreground mono-label hidden truncate sm:block">
                    {b.startedAt ? new Date(b.startedAt).toLocaleString() : '—'}
                  </span>
                  <div className="flex justify-end">
                    <StatusBadge tone={buildTone(b.status)} label={b.status} />
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
