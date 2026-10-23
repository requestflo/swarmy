import { useQueries } from '@tanstack/react-query';
import type { JobRunView, ScheduledJobView } from '@swarmy/core';
import { useTRPCClient } from '@/integrations/trpc';
import type { Window } from './yesterday-model';

/** A job every 15 minutes fills 96 runs a day: four pages of 100 reach back past yesterday. */
const MAX_PAGES = 4;

/**
 * Each job's runs back to the start of yesterday (`jobs.runs`, newest first,
 * paged until a run is older than the window). `undefined` until every job
 * answered, so the heatmap never shows a fake empty day.
 */
export function useYesterdayRuns(jobs: ScheduledJobView[] | undefined, w: Window): Map<string, JobRunView[]> | undefined {
  const client = useTRPCClient();
  const results = useQueries({
    queries: (jobs ?? []).map((job) => ({
      queryKey: ['jobs.runs.yesterday', job.id, w.from],
      refetchInterval: 30_000,
      queryFn: async (): Promise<JobRunView[]> => {
        const out: JobRunView[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await client.jobs.runs.query({ jobId: job.id, limit: 100, ...(cursor ? { cursor } : {}) });
          out.push(...res.runs);
          const oldest = res.runs.at(-1);
          if (!res.nextCursor || !oldest || Date.parse(oldest.startedAt) < w.from) break;
          cursor = res.nextCursor;
        }
        return out;
      },
    })),
  });
  if (!jobs || results.some((r) => r.data === undefined && !r.isError)) return undefined;
  return new Map(jobs.map((j, i) => [j.id, results[i]?.data ?? []]));
}
