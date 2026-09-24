import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { FilmIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';
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

  return (
    <div className="pb-8">
      <ObsSubTabs stack={stack} active="replays" aside={aside} />
      {s && !(s.enabled && s.mode === 'identified' && s.replaySampleRate > 0) ? (
        <p className="border-status-warning/40 bg-status-warning/8 mb-4 rounded-2xl border px-4 py-3 text-sm">
          New sessions aren't being recorded. Replay needs analytics on, identified mode and a sample rate above 0% —{' '}
          <Link to="/stacks/$name/rum-settings" params={{ name: stack }} className="text-primary font-semibold">
            change it in settings
          </Link>
          .
        </p>
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
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <SessionList
            stack={stack}
            sessions={sessions}
            activeId={selected}
            withErrors={withErrors}
            onWithErrors={setWithErrors}
          />
          {selected ? (
            <ReplayPlayer stack={stack} sessionId={selected} />
          ) : (
            <EmptyState
              icon={<FilmIcon />}
              title="Nothing to play yet."
              description="Recorded visits appear on the left a few seconds after they happen."
            />
          )}
        </div>
      )}
    </div>
  );
}
