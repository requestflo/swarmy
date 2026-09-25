import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { FilmIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';
import { Button } from '@swarmy/ui';
import { Depth, NextAction, Say, SayHeader } from '@/components/calm';
import { RumCode } from './rum-code';
import { ReplaySummaryList } from './replay-summary-list';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { ObsSubTabs } from './obs-sub-tabs';
import { ReplayPlayer } from './replay-player';
import { pct } from './rum-shared';
import { RumStateNotice, type RumNoticeKind } from './rum-state-notice';
import { SessionList } from './session-list';
import { useRumSettings } from './use-rum';

interface ReplaysPageProps {
  stack: string;
  /** The open session; the list's newest one when absent. */
  sessionId?: string;
}

/** Session replay: recorded visits on the left, the synced player on the right. */
export function ReplaysPage({ stack, sessionId }: ReplaysPageProps): React.JSX.Element {
  const trpc = useTRPC();
  const [withErrors, setWithErrors] = React.useState(false);
  const settings = useRumSettings(stack);
  const list = useQuery({
    ...trpc.rum.replays.queryOptions({ stack, days: 7, withErrors: withErrors || undefined, limit: 100 }),
    refetchInterval: 15_000,
  });
  const s = settings.data?.settings;
  const sessions = list.data?.sessions ?? [];
  const selected = sessionId ?? sessions[0]?.sessionId;
  const aside = s
    ? `${sessions.length} sessions this week · ${pct(s.replaySampleRate)} sampled · inputs masked`
    : undefined;

  const notice: RumNoticeKind | null =
    list.data?.status === 'disabled'
      ? 'replay-disabled'
      : list.data?.status === 'unreachable'
        ? 'unreachable'
        : settings.data && !settings.data.stores.replay
          ? 'no-store'
          : null;

  const recording = !!s && s.enabled && s.mode === 'identified' && s.replaySampleRate > 0;
  const withErr = sessions.filter((x) => x.errors > 0).length;
  const title = !recording && sessions.length === 0
    ? <>{stack} isn’t recording visits.</>
    : <>{sessions.length} {sessions.length === 1 ? 'visit' : 'visits'} recorded this week. {withErr ? <Say tone="warn">{withErr} hit an error.</Say> : <em>None hit an error.</em>}</>;
  const lede = s
    ? `${pct(s.replaySampleRate)} of signed-in visits are recorded, inputs always masked${s.maskAllText ? ', all text masked' : ''}. Kept ${s.retentionDays} days.`
    : undefined;

  return (
    <div className="flex flex-col gap-4 pb-8">
      <SayHeader size="md" title={title} lede={lede} />
      <ObsSubTabs stack={stack} active="replays" aside={aside} />
      {s && settings.data ? <RumCode stack={stack} settings={s} routes={settings.data.routes} /> : null}
      {s && !recording ? (
        <NextAction
          title="New visits aren’t being recorded"
          tech="replay needs enabled · mode=identified · replaySampleRate > 0"
          actions={
            <Button asChild>
              <Link to="/stacks/$name/rum-settings" params={{ name: stack }}>Turn on recording</Link>
            </Button>
          }
        >
          Replay needs analytics on, signed-in (identified) mode and a share of visits to record.
        </NextAction>
      ) : null}
      {list.isPending || settings.isPending ? (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <CardSkeleton lines={6} />
          <CardSkeleton lines={8} className="min-h-[420px]" />
        </div>
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} retrying={list.isFetching} />
      ) : notice ? (
        <RumStateNotice stack={stack} kind={notice} />
      ) : (
        <>
          <Depth only="summary">
            {sessionId ? <ReplayPlayer stack={stack} sessionId={sessionId} /> : <ReplaySummaryList stack={stack} sessions={sessions} />}
          </Depth>
          <Depth at="controls">
            <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
              <SessionList stack={stack} sessions={sessions} activeId={selected} withErrors={withErrors} onWithErrors={setWithErrors} />
              {selected ? (
                <ReplayPlayer stack={stack} sessionId={selected} />
              ) : (
                <EmptyState icon={<FilmIcon />} title="Nothing to play yet." description="Recorded visits appear on the left a few seconds after they happen." />
              )}
            </div>
          </Depth>
        </>
      )}
    </div>
  );
}
