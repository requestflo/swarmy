import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { InboundWebhooksOverview, JobsOverview, QueueView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { NextAction, Say, SayHeader } from '@/components/calm';
import { plural } from '../tab-body';

interface Props {
  queues: QueueView[];
  jobs: JobsOverview;
  hooks: InboundWebhooksOverview;
}

/** "2 queues, 450 jobs waiting. Nothing stuck." + the one stuck thing, if any. */
export function MessagingHeader({ queues, jobs, hooks }: Props): React.JSX.Element {
  const waiting = queues.reduce((n, q) => n + (q.stats?.wait ?? 0), 0);
  const failed = queues.reduce((n, q) => n + (q.stats?.failed ?? 0), 0);
  const stuck = failed + hooks.dead + jobs.failed24h;
  const title = (
    <>
      {plural(queues.length, 'queue')}, {plural(waiting, 'job')} waiting.{' '}
      {stuck === 0 ? (
        <em>Nothing stuck.</em>
      ) : failed > 0 ? (
        <Say tone="warn">{failed.toLocaleString()} failed and need a look.</Say>
      ) : hooks.dead > 0 ? (
        <Say tone="warn">{plural(hooks.dead, 'webhook')} couldn't be delivered.</Say>
      ) : (
        <Say tone="warn">{plural(jobs.failed24h, 'scheduled run')} failed today.</Say>
      )}
    </>
  );
  const lede = `${plural(jobs.enabled, 'scheduled job')} and ${plural(hooks.endpoints, 'webhook endpoint')}; ${hooks.deliveries24h.toLocaleString()} events came in today.`;
  return <SayHeader size="md" title={title} lede={lede} />;
}

/** The one stuck thing worth a look: the queue with the most failed jobs. */
export function MessagingNext({ stack, queues }: { stack: string; queues: QueueView[] }): React.JSX.Element | null {
  const worst = [...queues].sort((a, b) => (b.stats?.failed ?? 0) - (a.stats?.failed ?? 0))[0];
  if (!worst || (worst.stats?.failed ?? 0) === 0) return null;
  return (
    <NextAction
      title={`${worst.name} has ${worst.stats!.failed.toLocaleString()} failed jobs`}
      tech={`${worst.workerService} · ${worst.cacheStack}/${worst.cacheName} · ${worst.retries} retries each`}
      actions={
        <Button asChild>
          <Link to="/stacks/$name/queues/$cluster" params={{ name: stack, cluster: worst.cacheName }}>
            Look at the failed jobs
          </Link>
        </Button>
      }
    >
      They ran out of retries. Open the queue to see why, then retry them all at once or clear them.
    </NextAction>
  );
}
