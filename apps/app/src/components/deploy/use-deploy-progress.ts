import * as React from 'react';
import type { BlueprintDeployResultView } from '@swarmy/core';
import { settle, type DeployProgress, type StepKey } from './deploy-steps';
import { eventServer, foldStages, mergeSteps, type DeployEvent } from './deploy-events';
import { useDeployEvents } from './use-deploy-events';
import { useDeployPoll } from './use-deploy-poll';

export interface DeployWatch extends DeployProgress {
  /** Inventory + routes have landed at least once (until then: skeleton). */
  ready: boolean;
  /** Seconds after the deploy started that each step finished. */
  doneAt: Partial<Record<StepKey, number>>;
  /** Seconds after the deploy started that each working step began (events only). */
  startedAt: Partial<Record<StepKey, number>>;
  /** When the deploy started (the controller's clock when streamed, else this tab's send). */
  since: number | null;
  /** The deploy's own events, for the live log (empty without a deploy id). */
  events: DeployEvent[];
  /** The traced deploy's id, when there is one. */
  deployId: string | null;
  /** Streaming right now (a deploy id, events arriving). */
  streaming: boolean;
  /** The server its main service runs on, when swarmy knows it. */
  server: string | null;
  stackId: string | null;
}

/**
 * Watch a fresh deploy. With a deploy id, the tracker's steps, times and the
 * log come from the deploy's streamed events (`deploys.events`); polling
 * (inventory, routes) stays underneath as the fallback — for a reload with
 * no id, a stage with no events, or a stream quiet for more than 10 s.
 */
export function useDeployProgress(
  stack: string,
  result: BlueprintDeployResultView | null,
  sentAt: number | null,
  deployId: string | null,
): DeployWatch {
  const stream = useDeployEvents(deployId);
  const t0 = stream.startedAt ?? sentAt;
  const folds = React.useMemo(() => foldStages(stream.events, t0 ?? 0), [stream.events, t0]);
  const eventsLive = stream.events.length > 0 && folds.health?.state === 'done';
  const poll = useDeployPoll(stack, result, sentAt, stream.events.length > 0 && !eventsLive && !stream.stale);
  const steps = React.useMemo(() => mergeSteps(poll.steps, folds, stream.stale), [poll.steps, folds, stream.stale]);

  const doneAt: DeployWatch['doneAt'] = { ...poll.doneAt };
  const startedAt: DeployWatch['startedAt'] = {};
  for (const [k, f] of Object.entries(folds) as Array<[StepKey, NonNullable<(typeof folds)[StepKey]>]>) {
    if (f.doneSec !== null) doneAt[k] = f.doneSec;
    else delete doneAt[k];
    startedAt[k] = f.startedSec;
  }
  return {
    ...poll,
    ...settle(steps),
    doneAt,
    startedAt,
    since: t0,
    events: stream.events,
    deployId,
    streaming: stream.events.length > 0 && !stream.stale && !stream.ended,
    server: eventServer(stream.events) ?? poll.server,
  };
}
