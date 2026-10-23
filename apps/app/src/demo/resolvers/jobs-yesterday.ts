import type { JobRunView, ScheduledJobView } from '@swarmy/core';
import type { DomainResolvers } from '../types';

/**
 * storefront's scheduled day for Config › Jobs & previews (board AppJobs):
 * the hourly cache warm-up ran all of yesterday (UTC) with one miss at
 * 13:00, the nightly sitemap ran at 03:30, and the search reindex timed out
 * at 04:00 and went through on its retry at 04:05. Appended to the jobs
 * module's state after it seeds (registered later in MODULES), so
 * `jobs.list` / `jobs.runs` / `jobs.overview` all tell the same day.
 */

type Job = Omit<ScheduledJobView, 'scheduleText' | 'lastRunStatus' | 'nextRunAt'> & { stackName: string | null };
interface JobsState {
  jobs: Job[];
  runs: JobRunView[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

const WARM = '$ node scripts/warm-cache.js --top 500\nwarmed 500 keys in 12.4s';
const WARM_FAIL = '$ node scripts/warm-cache.js --top 500\nError: connect ECONNRESET storefront_cache:6379\n    at TCPConnectWrap.afterConnect (node:net:1607:16)\nexit status 1 · next run on the hour';
const SITEMAP = '$ npm run sitemap\nwrote 4,112 urls to s3://storefront-media/sitemap.xml\ndone in 11.8s';
const REINDEX_FAIL = '$ npm run reindex -- --index products\nindexing products (41,208 docs)\nerror: meilisearch request timed out after 30s (task 8812 still enqueued)\nexit status 1 · swarmy retries in 5 min (1 of 2)';
const REINDEX_OK = '$ npm run reindex -- --index products\nindexing products (41,208 docs)\n41,208 docs indexed in 41.3s';

function job(id: string, name: string, schedule: string, serviceRef: string, command: string, retries: number, createdAgo: number): Job {
  return {
    id, name, stackName: 'storefront', schedule, kind: 'service-exec', image: null, serviceRef,
    command: ['sh', '-c', command], env: {}, runOn: {}, timeoutMs: 600_000, retries, alertOnFailure: true,
    enabled: true, lastRunAt: null, createdAt: new Date(Date.now() - createdAgo).toISOString(),
  };
}

export const jobsYesterday: DomainResolvers = {
  seed: (store) => {
    const st = store.extra.jobs as JobsState | undefined;
    if (!st || st.jobs.some((j) => j.id === 'job-sitemap')) return;
    const now = Date.now();
    const today = Math.floor(now / DAY) * DAY;
    const runs: JobRunView[] = [];
    const add = (jobId: string, at: number, ok: boolean, tookMs: number, out: string, attempt = 1): void => {
      if (at > now - 5 * MIN) return;
      const iso = (t: number): string => new Date(t).toISOString();
      runs.push({ id: `run-${jobId}-${at}-${attempt}`, jobId, status: ok ? 'succeeded' : 'failed', exitCode: ok ? 0 : 1, outputTail: out, attempt, startedAt: iso(at), finishedAt: iso(at + tookMs) });
    };
    // The hourly warm-up: all of yesterday, and today up to the runs the jobs module already has.
    for (let t = today - DAY; t < now - 3.5 * HOUR; t += HOUR) {
      const miss = t === today - DAY + 13 * HOUR;
      add('job-cache-warmup', t, !miss, miss ? 1_200 : 12_000 + ((t / HOUR) % 5) * 400, miss ? WARM_FAIL : WARM);
    }
    for (const d of [today - DAY, today]) {
      add('job-sitemap', d + 3.5 * HOUR, true, 11_800, SITEMAP);
      add('job-reindex', d + 4 * HOUR, d === today, d === today ? 41_300 : 30_400, d === today ? REINDEX_OK : REINDEX_FAIL);
    }
    add('job-reindex', today - DAY + 4 * HOUR + 5 * MIN, true, 41_300, REINDEX_OK, 2);
    st.jobs.push(
      job('job-sitemap', 'sitemap', '30 3 * * *', 'storefront_web', 'npm run sitemap', 1, 40 * DAY),
      job('job-reindex', 'reindex-search', '0 4 * * *', 'storefront_api', 'npm run reindex -- --index products', 2, 25 * DAY),
    );
    for (const j of st.jobs) {
      const last = [...runs, ...st.runs].filter((r) => r.jobId === j.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (last && (!j.lastRunAt || last.startedAt > j.lastRunAt)) j.lastRunAt = last.startedAt;
    }
    st.runs = [...st.runs, ...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },
};
