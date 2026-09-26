import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CodeView } from '@/components/calm';
import { TabBody } from '@/components/app-tabs/tab-body';
import { HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { queuesCode } from './queues-code';
import { QueuesHeader, QueuesNext } from './queues-header';
import { StackQueuesSection } from './stack-queues-section';

/** Data › Queues (board AppJobs' queue half): every queue and its worker; a store opens in the queue studio. */
export function QueuesTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const queues = useQuery({ ...trpc.queues.list.queryOptions({ stack }), refetchInterval: 5_000 });
  return (
    <TabBody
      asideAt="code"
      header={queues.data ? <QueuesHeader queues={queues.data} /> : <HeaderSkeleton />}
      aside={queues.data ? <CodeView title="Queues as code" tabs={queuesCode(stack, queues.data)} source="yaml" /> : undefined}
    >
      {queues.data ? <QueuesNext stack={stack} queues={queues.data} /> : null}
      <div id="queues" className="scroll-mt-4">
        <StackQueuesSection stack={stack} />
      </div>
    </TabBody>
  );
}
