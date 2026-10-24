import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { scaleDownWords, type QueueDepthSample } from '@swarmy/core';
import { CalmRow, Section, SectionLink } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { RowsSkeleton } from '../tab-body';
import { useStackServices } from '../use-stack-services';
import { WorkerToday } from './worker-today';
import { workerRows, type WorkerRow } from './workers-model';

const copies = (c: { desired: number; running: number }): string =>
  c.running < c.desired ? `${c.running} of ${c.desired} copies up` : `${c.desired} ${c.desired === 1 ? 'copy' : 'copies'}`;

/**
 * Workers (board AppJobs): parts with no address — and every queue's worker —
 * with copies and, where a queue exists, its live depth (`queues.stats`) and
 * the jobs it finished today (`queues.depthHistory`).
 */
export function WorkersSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const { services } = useStackServices(stack);
  const queues = useQuery({ ...trpc.queues.list.queryOptions({ stack }), refetchInterval: 15_000 });
  const stats = useQueries({
    queries: (queues.data ?? []).map((q) => ({ ...trpc.queues.stats.queryOptions({ workerService: q.workerService, queue: q.name }), refetchInterval: 15_000 })),
  });
  const depth = new Map<string, QueueDepthSample | null>((queues.data ?? []).map((q, i) => [`${q.workerService}/${q.name}`, stats[i]?.data ?? q.stats]));
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
            <WorkerLine key={r.service} r={r} depth={depth} />
          ))}
        </div>
      )}
    </Section>
  );
}

function WorkerLine({ r, depth }: { r: WorkerRow; depth: Map<string, QueueDepthSample | null> }): React.JSX.Element {
  const short = r.copies.running < r.copies.desired;
  const queueWords = r.queues.map((q) => {
    const d = depth.get(`${q.workerService}/${q.name}`);
    return d ? `${q.name}: ${d.wait.toLocaleString()} waiting, ${d.active} in progress${d.failed ? `, ${d.failed} failed` : ''}` : `${q.name}: not measured yet`;
  });
  const asleep = r.inv?.status === 'idle';
  return (
    <CalmRow
      tone={short ? 'warn' : asleep ? 'idle' : 'ok'}
      name={r.part}
      sub={r.queues.length ? `${r.queues.length} queue${r.queues.length === 1 ? '' : 's'}` : 'no queue'}
      say={[copies(r.copies), ...queueWords].join(' · ')}
      tech={r.queues.length ? r.queues.map((q) => `${q.name} ${q.convention} on ${q.cacheName} · ${q.minWorkers}–${q.maxWorkers} copies, 1 per ${q.scalePerJobs} waiting, ${scaleDownWords(q.minWorkers, q.cooldownSeconds)}`).join(' · ') : `${r.service} · no published port, no route`}
      trailing={r.queues.length ? <WorkerToday queues={r.queues} /> : undefined}
      word={short ? 'Short' : asleep ? 'Asleep' : 'Running'}
      wordTone={short ? 'warn' : asleep ? 'idle' : 'ok'}
    />
  );
}
