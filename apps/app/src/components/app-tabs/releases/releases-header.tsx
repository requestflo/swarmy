import * as React from 'react';
import { Undo2Icon } from 'lucide-react';
import type { ReleaseView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { NextAction, Say, SayHeader } from '@/components/calm';
import { RollbackConfirm } from '@/components/releases/rollback-confirm';
import { actorName, agoWords, lastGood, releaseLabel } from './release-label';

/** "v1.9.0 is live, deployed by sam 2 hours ago." + the put-back action when there is something to put back. */
export function ReleasesHeader({ rows }: { rows: ReleaseView[] }): React.JSX.Element {
  const head = rows[0];
  if (!head) {
    return (
      <SayHeader
        size="md"
        title={<>No versions yet. <em>Deploy once and every version lands here.</em></>}
        lede="Each deploy is kept with what changed and whether it stayed healthy, so any of them can go back."
      />
    );
  }
  const label = releaseLabel(head);
  const by = `${actorName(head.actor)} ${agoWords(head.createdAt)}`;
  const good = lastGood(rows);
  const goodLabel = releaseLabel(good);
  const failed = rows.filter((r) => r.status === 'failed').length;
  const title =
    head.status === 'deploying' ? (
      <>{label} is rolling out, <em>started by {by}.</em></>
    ) : head.status === 'failed' ? (
      <>{label} <Say tone="bad">failed its health check.</Say> <em>Deployed by {by}.</em></>
    ) : head.status === 'rolled-back' ? (
      <>{label} <Say tone="warn">was put back.</Say> <em>Deployed by {by}.</em></>
    ) : (
      <>{label} is live, <em>deployed by {by}.</em></>
    );
  const broken = head.status === 'failed' || head.status === 'rolled-back';
  return (
    <div className="flex flex-col gap-5">
      <SayHeader
        size="md"
        title={title}
        lede={`${rows.length} version${rows.length === 1 ? '' : 's'} so far${failed ? `, ${failed} failed` : ''}. swarmy keeps each one with what changed, so any of them can go back.`}
        actions={
          good && !broken ? (
            <RollbackConfirm
              release={good}
              label={goodLabel}
              trigger={
                <Button variant="outline" className="pointer-coarse:min-h-11">
                  <Undo2Icon className="size-4" /> Put back {goodLabel}
                </Button>
              }
            />
          ) : undefined
        }
      />
      {good && broken ? (
        <NextAction
          tone={head.status === 'failed' ? 'bad' : 'warn'}
          title={`Put back ${goodLabel}, the last version that stayed healthy`}
          tech={`releases.rollback · redeploys ${good.images.map((i) => i.image).join(', ')} as a new release`}
          actions={<RollbackConfirm release={good} label={goodLabel} trigger={<Button>Put back {goodLabel}</Button>} />}
        >
          It runs again one copy at a time, so visitors never see a gap. {label} stays in the history.
        </NextAction>
      ) : null}
    </div>
  );
}
