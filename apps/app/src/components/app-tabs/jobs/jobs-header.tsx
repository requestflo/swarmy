import * as React from 'react';
import type { InboundWebhooksOverview, JobsOverview } from '@swarmy/core';
import { Say, SayHeader } from '@/components/calm';
import { plural } from '../tab-body';

/** "3 scheduled jobs and 2 webhook endpoints. Nothing stuck." */
export function JobsHeader({ jobs, hooks, previews }: { jobs: JobsOverview; hooks: InboundWebhooksOverview; previews: number }): React.JSX.Element {
  const title = (
    <>
      {plural(jobs.enabled, 'scheduled job')} and {plural(hooks.endpoints, 'webhook endpoint')}.{' '}
      {hooks.dead > 0 ? (
        <Say tone="warn">{plural(hooks.dead, 'webhook')} couldn&apos;t be delivered.</Say>
      ) : jobs.failed24h > 0 ? (
        <Say tone="warn">{plural(jobs.failed24h, 'scheduled run')} failed today.</Say>
      ) : (
        <em>Nothing stuck.</em>
      )}
    </>
  );
  const lede = `${hooks.deliveries24h.toLocaleString()} events came in today${previews ? `; ${plural(previews, 'branch preview')} running` : ''}.`;
  return <SayHeader size="md" title={title} lede={lede} />;
}
