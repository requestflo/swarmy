import * as React from 'react';
import { Undo2Icon } from 'lucide-react';
import type { ReleaseView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';
import { RollbackConfirm } from '@/components/releases/rollback-confirm';
import { momentLabel } from './time-travel-model';
import type { Replay } from './time-travel-replay';
import type { ReplayCall } from './replay-graph-model';
import { ReplayGraph } from './replay-graph';
import { PartCard } from './replay-part-card';

interface ReplaySectionProps {
  stack: string;
  at: number;
  live: boolean;
  replay: Replay;
  /** Today's release, to tell whether putting the one at T back would change anything. */
  head: ReleaseView | undefined;
  firstAt: number | null;
  /** Calls between the parts the traces saw before T, and that window's end (ms). */
  calls?: { calls: ReplayCall[]; until: number } | null;
}

/**
 * "<app> as it was at T": each part with the image it ran then, read-only.
 * When that version differs from today's, Put back vN redeploys it (code
 * only; the data is not touched) through the existing confirm.
 */
export function ReplaySection({ stack, at, live, replay, head, firstAt, calls }: ReplaySectionProps): React.JSX.Element {
  const { release, parts, later } = replay;
  const graph = calls?.calls.length ? calls : null;
  const label = releaseLabel(release ?? undefined);
  const differs = Boolean(release && head && release.id !== head.id && parts.some((p) => p.changed));
  return (
    <Section
      title={live ? `${stack} right now` : `${stack} as it was at ${momentLabel(at)}`}
      hint={live ? 'what runs' : 'read-only replay'}
      action={
        !live && release && differs ? (
          <RollbackConfirm
            release={release}
            label={label}
            trigger={
              <Button variant="outline" size="sm" className="pointer-coarse:min-h-11">
                <Undo2Icon className="size-4" /> Put back {label}
              </Button>
            }
          />
        ) : undefined
      }
    >
      {release ? (
        <>
          <p className="text-muted-foreground text-[13.5px]">
            {live ? `Running ${label}.` : `Running ${label}${differs ? '. Putting it back redeploys these images; your data is not touched.' : ', the same as now.'}`}
          </p>
          {graph ? <ReplayGraph parts={parts} live={live} calls={graph.calls} until={graph.until} /> : null}
          {graph && later.length === 0 ? null : (
          <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
            {graph
              ? null
              : parts.map((p) => (
                  <PartCard key={p.name} p={p} live={live} />
                ))}
            {later.map((p) => (
              <li key={p.name} className="border-border flex flex-col gap-1 rounded-xl border border-dashed px-3.5 py-3 opacity-70">
                <span className="truncate text-[14px] font-semibold">{p.name}</span>
                <span className="text-muted-foreground font-mono text-[11px]">
                  not there yet{Number.isFinite(p.at) ? ` · arrives with ${p.label}, ${momentLabel(p.at)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          )}
          <Tech>releases.list · release {release.id} · {release.images.length} images</Tech>
        </>
      ) : (
        <p className="text-muted-foreground text-[13.5px]">
          {firstAt
            ? `No version on record this early. swarmy has every deploy of ${stack} from ${momentLabel(firstAt)} on.`
            : `${stack} has no deploys on record yet. Every deploy from now on can be replayed here.`}
        </p>
      )}
    </Section>
  );
}
