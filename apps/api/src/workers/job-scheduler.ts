import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { runDueScheduledJobs } from '@swarmy/trpc';
import { hub } from '../gateway';

/**
 * Scheduled-job worker (slice B2). Every 30s, fire every due, enabled
 * `ScheduledJob` via `jobs.service#runDueScheduledJobs` — the due rule, the
 * fire-before-execute double-fire guard, retries and the `job-failed` alert
 * all live there (unit-tested).
 */

const TICK_MS = 30_000;

export function startJobScheduler(): () => void {
  const timer = setInterval(() => {
    runDueScheduledJobs(new Date(), { db: prisma, hub, auth: authRegistry.getAuth() }).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
