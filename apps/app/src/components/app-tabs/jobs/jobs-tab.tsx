import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CodeView } from '@/components/calm';
import { findStackApp } from '@/components/gitops/gitops-types';
import { StackPreviewsSection } from '@/components/gitops/stack-previews-section';
import { StackJobsSection } from '@/components/jobs/stack-jobs-section';
import { StackWebhooksSection } from '@/components/webhookgw/stack-webhooks-section';
import { HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { TabBody } from '../tab-body';
import { jobsCode } from './jobs-code';
import { JobsHeader } from './jobs-header';

/**
 * Config › Jobs & previews (board AppJobs): scheduled jobs and webhooks (both
 * from the old Jobs & queues tab) and branch previews (from Releases). Queues
 * are Data › Queues.
 */
export function JobsTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const jobsOverview = useQuery({ ...trpc.jobs.overview.queryOptions({ stack }), refetchInterval: 5_000 });
  const jobs = useQuery({ ...trpc.jobs.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const hooks = useQuery({ ...trpc.inboundWebhooks.overview.queryOptions({ stack }), refetchInterval: 10_000 });
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  const ready = jobsOverview.data && hooks.data && apps.data;
  return (
    <TabBody
      asideAt="code"
      header={
        ready ? <JobsHeader jobs={jobsOverview.data} hooks={hooks.data} previews={match?.app.previews.length ?? 0} /> : <HeaderSkeleton />
      }
      aside={jobs.data ? <CodeView title="Jobs as code" tabs={jobsCode(stack, jobs.data)} source="yaml" /> : undefined}
    >
      <StackJobsSection stack={stack} />
      <StackWebhooksSection stack={stack} />
      {apps.data ? <StackPreviewsSection stack={stack} match={match} /> : null}
    </TabBody>
  );
}
