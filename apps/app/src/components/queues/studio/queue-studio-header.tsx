import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, RefreshCwIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { CodeView, Say, SayHeader, Tech } from '@/components/calm';
import type { StudioQueue } from './studio-types';

interface Props {
  stack: string;
  cluster: string;
  queues: StudioQueue[] | undefined;
  purpose: string | undefined;
  fetching: boolean;
  onRefresh: () => void;
}

/** "4 queues on main, 450 jobs waiting. 50 failed." + back link, refresh, and (Code) the live sample. */
export function QueueStudioHeader({ stack, cluster, queues, purpose, fetching, onRefresh }: Props): React.JSX.Element {
  const waiting = queues?.reduce((n, q) => n + q.backlog, 0) ?? 0;
  const failed = queues?.reduce((n, q) => n + q.counts.failed, 0) ?? 0;
  const n = queues?.length ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit pointer-coarse:min-h-11">
        <Link to="/stacks/$name/queues" params={{ name: stack }}>
          <ArrowLeftIcon className="size-4" /> All queues
        </Link>
      </Button>
      <SayHeader
        size="md"
        title={
          queues ? (
            <>
              {n} queue{n === 1 ? '' : 's'} on {cluster}, {waiting.toLocaleString()} jobs waiting.{' '}
              {failed > 0 ? <Say tone="warn">{failed.toLocaleString()} failed.</Say> : <em>Nothing stuck.</em>}
            </>
          ) : (
            <>Queues on {cluster}</>
          )
        }
        lede={
          <>
            Read through swarmy&apos;s agent; the store is never exposed to the internet.
            {purpose === 'cache' ? ' This store can drop keys when full, so use a queue store for BullMQ.' : ''}{' '}
            <Tech>
              BullMQ · {stack}/{cluster} · prefix bull
            </Tech>
          </>
        }
        actions={
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={fetching} onClick={onRefresh}>
            <RefreshCwIcon className={cn('size-3.5', fetching && 'animate-spin motion-reduce:animate-none')} /> Refresh
          </Button>
        }
      />
      {queues ? (
        <CodeView
          title="This store as swarmy sees it"
          source="readonly"
          tabs={[
            {
              label: 'sample',
              code: JSON.stringify(
                queues.map((q) => ({ name: q.name, counts: q.counts, paused: q.isPaused, perMinute: q.rate?.throughput ?? null })),
                null,
                2,
              ),
            },
          ]}
        />
      ) : null}
    </div>
  );
}
