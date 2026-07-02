import type { OrgContext } from '../context';

/**
 * Scheduled jobs — cron-fired one-shot containers / service execs (`ScheduledJob`/`JobRun`) (slice B2).
 *
 * Spine stub — slice B2 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice B2. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
