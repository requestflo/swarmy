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
import { JobCard } from './job-card';
import { jobsCode } from './jobs-code';
import { JobsHeader } from './jobs-header';
import { useYesterdayRuns } from './use-yesterday-runs';
import { WorkersSection } from './workers-section';
import { YesterdaySection } from './yesterday-section';
import { lanes as toLanes, yesterdayUtc } from './yesterday-model';

/**
 * Config › Jobs & previews (board AppJobs): yesterday's runs hour by hour,
 * the picked job in plain words with Run now, the workers (parts with no
 * address, with their queues), then every job, webhooks and branch previews.
 */
export function JobsTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const jobsOverview = useQuery({ ...trpc.jobs.overview.queryOptions({ stack }), refetchInterval: 5_000 });
  const jobs = useQuery({ ...trpc.jobs.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const hooks = useQuery({ ...trpc.inboundWebhooks.overview.queryOptions({ stack }), refetchInterval: 10_000 });
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  const ready = jobsOverview.data && hooks.data && apps.data;
  const day = React.useMemo(() => yesterdayUtc(Date.now()), []);
  const runs = useYesterdayRuns(jobs.data, day);
  const lanes = React.useMemo(() => (jobs.data && runs ? toLanes(jobs.data, runs, day) : undefined), [jobs.data, runs, day]);
  const [pickedId, setPickedId] = React.useState<string | null>(null);
  const picked = jobs.data?.find((j) => j.id === pickedId) ?? jobs.data?.[0];
  const hasJobs = (jobs.data?.length ?? 0) > 0;
  return (
    <TabBody
      asideAt="code"
      header={
        ready ? <JobsHeader jobs={jobsOverview.data} hooks={hooks.data} previews={match?.app.previews.length ?? 0} /> : <HeaderSkeleton />
      }
      aside={jobs.data ? <CodeView title="Jobs as code" tabs={jobsCode(stack, jobs.data)} source="yaml" /> : undefined}
    >
      {jobs.data === undefined || hasJobs ? <YesterdaySection lanes={lanes} runs={runs} picked={picked?.id} onPick={setPickedId} /> : null}
      {picked ? <JobCard key={picked.id} stack={stack} job={picked} runs={runs?.get(picked.id)} /> : null}
      <WorkersSection stack={stack} />
      <StackJobsSection stack={stack} />
      <StackWebhooksSection stack={stack} />
      {apps.data ? <StackPreviewsSection stack={stack} match={match} /> : null}
    </TabBody>
  );
}
