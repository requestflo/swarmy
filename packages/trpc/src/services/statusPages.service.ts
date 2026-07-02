import type { OrgContext } from '../context';

/**
 * Status pages — public component status, uptime history, incident feed (slice C5).
 *
 * Spine stub — slice C5 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice C5. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}

/**
 * Sample one uptime datapoint per enabled status-page component. Called each
 * tick by the alert-evaluator worker (slice C3).
 *
 * Spine stub — slice C5 replaces this with the real sampler.
 */
export async function sampleUptimeTick(): Promise<void> {}
