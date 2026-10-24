import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { QueueConnectedView, QueueDepthSample } from '@swarmy/core';
import { CalmRow, Section, SectionLink } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { RowsSkeleton } from '../tab-body';
import { useStackServices } from '../use-stack-services';
import { useQueueLive } from './use-queue-live';
import { WorkerToday } from './worker-today';
import { workerSay, workerTech } from './worker-words';
import { workerRows, type WorkerRow } from './workers-model';

/**
 * Workers (board AppJobs): parts with no address — and every queue's worker —
 * with copies and, where a queue exists, its live depth (`queues.stats`),
 * the BullMQ workers connected to it (`queues.connectedWorkers`) and the
 * jobs it finished today (`queues.depthHistory`).
 */
export function WorkersSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const { services } = useStackServices(stack);
  const queues = useQuery({ ...trpc.queues.list.queryOptions({ stack }), refetchInterval: 15_000 });
  const { depth, connected } = useQueueLive(queues.data);
  const rows = services && queues.data ? workerRows(stack, services, queues.data) : services && queues.isError ? workerRows(stack, services, []) : undefined;
  return (
    <Section
      title="Workers"
      count={rows?.length}
      hint="parts with no address"
      flush
      action={
        queues.data?.length ? (
          <Link to="/stacks/$name/queues" params={{ name: stack }}>
            <SectionLink>Queues →</SectionLink>
          </Link>
        ) : undefined
      }
    >
      {rows === undefined ? (
        <RowsSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground py-3 text-[13.5px]">Every part of {stack} has an address. A worker is a part with none: it takes jobs from a queue or a schedule instead.</p>
      ) : (
        <div className="flex flex-col">
          {rows.map((r) => (
            <WorkerLine key={r.service} r={r} depth={depth} connected={connected} />
          ))}
        </div>
      )}
    </Section>
  );
}

interface WorkerLineProps {
  r: WorkerRow;
  depth: Map<string, QueueDepthSample | null>;
  connected: Map<string, QueueConnectedView | undefined>;
}

function WorkerLine({ r, depth, connected }: WorkerLineProps): React.JSX.Element {
  const short = r.copies.running < r.copies.desired;
  const asleep = r.inv?.status === 'idle';
  return (
    <CalmRow
      tone={short ? 'warn' : asleep ? 'idle' : 'ok'}
      name={r.part}
      sub={r.queues.length ? `${r.queues.length} queue${r.queues.length === 1 ? '' : 's'}` : 'no queue'}
      say={workerSay(r, depth, connected)}
      tech={workerTech(r, connected)}
      trailing={r.queues.length ? <WorkerToday queues={r.queues} /> : undefined}
      word={short ? 'Short' : asleep ? 'Asleep' : 'Running'}
      wordTone={short ? 'warn' : asleep ? 'idle' : 'ok'}
    />
  );
}
