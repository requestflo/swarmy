import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import { buildTimeline, lastAt } from './replay-timeline';
import { ReplayControls } from './replay-controls';
import { ReplayHeader } from './replay-header';
import { ReplayScrubber } from './replay-scrubber';
import { ReplaySidePanel } from './replay-side-panel';
import { ReplayViewport } from './replay-viewport';
import { RumStateNotice } from './rum-state-notice';
import { useIsOrgAdmin } from './use-rum';
import { useReplayer } from './use-replayer';
import type { ReplayDetail } from './rum-shared';

interface ReplayPlayerProps {
  stack: string;
  sessionId: string;
}

/** Loads one session and hands it to the player, or says why it can't. */
export function ReplayPlayer({ stack, sessionId }: ReplayPlayerProps): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.rum.replay.queryOptions({ stack, sessionId }), staleTime: 60_000 });
  if (q.isPending) return <CardSkeleton lines={6} className="min-h-[420px]" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} retrying={q.isFetching} />;
  const d = q.data;
  if (d.status === 'ok' && d.events.length >= 2) return <Player key={sessionId} stack={stack} detail={d} />;
  const kind =
    d.status === 'no-store' ? 'no-store' : d.status === 'unreachable' ? 'unreachable' : d.status === 'disabled' ? 'replay-disabled' : 'not-found';
  return <RumStateNotice stack={stack} kind={kind} />;
}

function Player({ stack, detail }: { stack: string; detail: ReplayDetail }): React.JSX.Element {
  const admin = useIsOrgAdmin();
  const timeline = React.useMemo(() => buildTimeline(detail), [detail]);
  const stage = React.useRef<HTMLDivElement>(null);
  const p = useReplayer(detail.events, stage, timeline.total);
  const page = lastAt(timeline.pages, p.time);
  const now = lastAt(timeline.ticks, p.time);

  return (
    <div className="grid min-w-0 gap-4 min-[1800px]:grid-cols-[minmax(0,1fr)_380px]">
      <section className="flex min-w-0 flex-col gap-3" aria-label="Player">
        <ReplayHeader stack={stack} detail={detail} linked={detail.requests.length > 0} admin={admin} />
        <ReplayViewport stageRef={stage} size={p.size} ready={p.ready} url={page?.href ?? ''} />
        <ReplayScrubber ticks={timeline.ticks} time={p.time} total={timeline.total} onSeek={p.seek} />
        <ReplayControls
          playing={p.playing}
          ready={p.ready}
          time={p.time}
          total={timeline.total}
          speed={p.speed}
          nowLabel={now?.label}
          onToggle={p.toggle}
          onSpeed={p.setSpeed}
        />
      </section>
      <ReplaySidePanel stack={stack} timeline={timeline} time={p.time} onSeek={p.seek} />
    </div>
  );
}
