/**
 * Off-site mirror scheduler.
 *
 * Once a minute: reap orphaned runs and start every enabled `OffsiteMirror`
 * whose `nextRunAt` is due — a one-shot rclone copy of swarmy's Garage store
 * (backups, edge certs, app buckets) into the org's off-site S3 destination.
 * All logic (due check, bucket plan, env-only rclone config, run recording)
 * lives in `@swarmy/trpc` `runDueMirrors`; this file only ticks. Runs are long
 * (hours for a first copy), so a tick starts them and returns — the service's
 * per-org in-flight guard + RUNNING-row check stop a second run overlapping.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { runDueMirrors } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 60_000;
/** Nodes reconnect a few seconds after boot — don't fan out to zero managers. */
const FIRST_RUN_MS = 60_000;

export function startOffsiteMirror(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueMirrors({ db: prisma, hub, auth: authRegistry.getAuth() });
    } catch {
      // best-effort; failures are recorded on OffsiteMirrorRun rows.
    } finally {
      running = false;
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  const kickoff = setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), TICK_MS);
  }, FIRST_RUN_MS);
  return () => {
    clearTimeout(kickoff);
    if (timer) clearInterval(timer);
  };
}
