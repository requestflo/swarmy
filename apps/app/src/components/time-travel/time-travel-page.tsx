import * as React from 'react';
import { HistoryIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { CalmTopBar, CodeView } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { agoLabel, momentLabel } from './time-travel-model';
import { changesSince, nearestRestorePoint, replayAt } from './time-travel-replay';
import { timeTravelCode } from './time-travel-code';
import { TimeTravelHeader } from './time-travel-header';
import { ChangesSince, ViewingCard } from './changes-since';
import { AppRestoreCard } from './app-restore-card';
import { ReplaySection } from './replay-section';
import { RestorePointCard } from './restore-point-card';
import { TravelTimeline } from './travel-timeline';
import { useAppRestore } from './use-app-restore';
import { useDbSize } from './use-db-size';
import { useReplayCalls } from './use-replay-calls';
import { replayCalls } from './replay-graph-model';
import { useTimeTravel } from './use-time-travel';
import { useTravelHead } from './use-travel-head';

/**
 * Time travel (board 10): one app over the last 7 days. Drag the head (or
 * ←/→ between deploys, incidents and backups) to see what ran then, what
 * changed since, and restore the database to the nearest save — as a copy or
 * in place — or put every saved part of the app back to that moment at once.
 * Read-only until you press a restore or put-back button.
 */
export function TimeTravelPage({ stack }: { stack: string }): React.JSX.Element {
  const d = useTimeTravel(stack);
  const head = useTravelHead(d.events, d.now);
  const replay = replayAt(d.releases, head.at);
  const changes = changesSince(d.releases, head.at);
  const firstAt = d.releases.length ? Math.min(...d.releases.map((r) => Date.parse(r.createdAt))) : null;
  const db = d.databases[0];
  const point = db?.saves ? nearestRestorePoint(db.saves, head.at) : null;
  const app = useAppRestore(stack, d, head.at);
  const size = useDbSize(stack, db, d.now);
  const traced = useReplayCalls(head.at, head.live);
  const calls = traced.until === null ? null : { calls: replayCalls(stack, replay.parts.map((p) => p.name), traced.edges), until: traced.until };

  const chip = head.live ? (
    <span className="text-tone-ok border-tone-ok/40 inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold">
      <HistoryIcon aria-hidden className="size-3.5" /> Live
    </span>
  ) : (
    <span className="text-tone-info border-tone-info/40 inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold">
      <HistoryIcon aria-hidden className="size-3.5" /> Viewing {momentLabel(head.at)} · {agoLabel(head.at, d.now)}
    </span>
  );

  return (
    <div className="flex min-h-full flex-col">
      <CalmTopBar
        crumbs={[{ label: 'Apps', to: '/' }, { label: stack, to: '/stacks/$name', params: { name: stack } }, { label: 'Time travel' }]}
        meta={chip}
        actions={
          <>
            <span className="text-muted-foreground hidden font-mono text-[11.5px] lg:inline">
              <kbd className="border-border rounded border px-1">←</kbd> <kbd className="border-border rounded border px-1">→</kbd> step events
            </span>
            <Button variant="outline" size="sm" onClick={head.toNow} disabled={head.live} className="pointer-coarse:min-h-11">
              Back to now
            </Button>
          </>
        }
      />
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-6 pt-7 pb-28 lg:pb-6 xl:px-8">
        <TimeTravelHeader stack={stack} ready={d.ready} live={head.live} at={head.at} events={d.events} replay={replay} changes={changes} />
        {d.error ? (
          <ErrorState title="Couldn't load this app's history" error={d.error} />
        ) : !d.ready ? (
          <CardSkeleton lines={4} />
        ) : (
          <>
            <TravelTimeline events={d.events} head={head} now={d.now} partial={d.partial} size={size} className="order-1 lg:sticky lg:bottom-4 lg:z-10 lg:order-3" />
            <div className="order-2 grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
              <div className="flex min-w-0 flex-col gap-5">
                <ReplaySection stack={stack} at={head.at} live={head.live} replay={replay} head={d.releases[0]} firstAt={firstAt} calls={calls} />
                {head.live ? null : <AppRestoreCard stack={stack} at={head.at} now={d.now} app={app} onGo={head.go} />}
              </div>
              <aside className="flex min-w-0 flex-col gap-4" aria-label="This moment">
                <CodeView
                  tabs={timeTravelCode({ stack, at: head.at, replay, changes, cluster: db?.row.cluster ?? null, point, wholeApp: head.live ? null : app.plan })}
                  source="readonly"
                  note="Read-only: releases and database restores have no public REST path yet."
                />
                <ViewingCard at={head.at} live={head.live} now={d.now} events={d.events} />
                <ChangesSince changes={changes} live={head.live} now={d.now} />
                <RestorePointCard stack={stack} databases={d.databases} at={head.at} now={d.now} />
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
