import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CodeView } from '@/components/calm';
import { StackJobsSection } from '@/components/jobs/stack-jobs-section';
import { StackQueuesSection } from '@/components/queues/stack-queues-section';
import { StackWebhooksSection } from '@/components/webhookgw/stack-webhooks-section';
import { HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { TabBody } from '../tab-body';
import { messagingCode } from './messaging-code';
import { MessagingHeader, MessagingNext } from './messaging-header';

/** Jobs & queues: queues, webhooks and scheduled jobs as quiet sections. Boards AppJobs · QueueStudio. */
export function MessagingTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const queues = useQuery({ ...trpc.queues.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const jobsOverview = useQuery({ ...trpc.jobs.overview.queryOptions({ stack }), refetchInterval: 5_000 });
  const jobs = useQuery({ ...trpc.jobs.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const hooks = useQuery({ ...trpc.inboundWebhooks.overview.queryOptions({ stack }), refetchInterval: 10_000 });
  const ready = queues.data && jobsOverview.data && hooks.data;
  return (
    <TabBody
      asideAt="code"
      header={
        ready ? (
          <MessagingHeader queues={queues.data} jobs={jobsOverview.data} hooks={hooks.data} />
        ) : (
          <HeaderSkeleton />
        )
      }
      aside={
        queues.data && jobs.data ? (
          <CodeView title="Jobs & queues as code" tabs={messagingCode(stack, jobs.data, queues.data)} source="yaml" />
        ) : undefined
      }
    >
      {ready ? <MessagingNext stack={stack} queues={queues.data} /> : null}
      <StackQueuesSection stack={stack} />
      <StackJobsSection stack={stack} />
      <StackWebhooksSection stack={stack} />
    </TabBody>
  );
}
