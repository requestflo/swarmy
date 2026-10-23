import * as React from 'react';
import { SayHeader } from '@/components/calm';
import { agoWords, releaseLabel } from '@/components/app-tabs/releases/release-label';
import { plural } from '@/components/app-tabs/tab-body';
import { HeaderSkeleton } from '@/components/states';
import { momentLabel, type TravelEvent } from './time-travel-model';
import type { Change, Replay } from './time-travel-replay';

interface TimeTravelHeaderProps {
  stack: string;
  ready: boolean;
  live: boolean;
  at: number;
  events: TravelEvent[];
  replay: Replay;
  changes: Change[];
}

/** "storefront as it was 2 days ago. 3 versions went out since." — and the week in numbers at now. */
export function TimeTravelHeader({ stack, ready, live, at, events, replay, changes }: TimeTravelHeaderProps): React.JSX.Element {
  if (!ready) return <HeaderSkeleton />;
  if (live) {
    const n = (k: TravelEvent['kind']): number => events.filter((e) => e.kind === k).length;
    return (
      <SayHeader
        size="md"
        title={
          <>
            {stack}, right now. <em>Drag the head back to see it as it was.</em>
          </>
        }
        lede={`In the last 7 days: ${plural(n('deploy'), 'deploy')}, ${plural(n('incident'), 'incident')} and ${plural(n('backup'), 'backup')}. ←/→ steps between them.`}
      />
    );
  }
  const since = changes.length ? `${plural(changes.length, 'version')} went out since.` : 'Nothing has changed since.';
  return (
    <SayHeader
      size="md"
      title={
        <>
          {stack} as it was {agoWords(new Date(at).toISOString())}. <em>{since}</em>
        </>
      }
      lede={
        replay.release
          ? `${momentLabel(at)}: running ${releaseLabel(replay.release)}. This is a read-only replay; nothing changes until you put something back.`
          : `${momentLabel(at)}: there is no version on record this early.`
      }
    />
  );
}
