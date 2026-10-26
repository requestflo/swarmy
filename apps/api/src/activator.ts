import { Hono } from 'hono';
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { reapplyIngressForOrg, recordWakeTime } from '@swarmy/trpc';
import { hub, store } from './gateway';
import { safeReturn } from './activator-return';
import { findWakeable, orgForWakeToken } from './activator-auth';

/**
 * Scale-to-zero activator (epic #4B).
 *
 * Ingress routes a cold (0-replica) service's traffic here, at the signed path
 * the edge config carries (`/_wake/<service>/<token>`, see
 * `@swarmy/core/wake-token`). We verify the token, record the request (the
 * idle-tracking signal the sleeper uses), scale the service up to its target,
 * wait for a task to come live, then 307 the caller back so ingress serves it
 * directly. An unsigned or forged path wakes nothing. The dashboard's "Wake
 * now" button doesn't come here: it is the org-scoped `services.wake` mutation.
 *
 * Wake-on-request needs no DB: the service, its org, and its target replica count
 * all come from the live Docker inventory in the in-memory hub.
 *
 * Cold-start time (board 34): a wake that started a copy is timed from the
 * request arriving to the visitor being sent back (a running copy and the
 * edge re-rendered to serve it) and kept in memory (`recordWakeTime`).
 * Concurrent requests to one sleeping service share one wake, so they make
 * one sample and one re-render.
 */
const lastActivity = new Map<string, number>();

/** A request reached `name` at `at` (default now); an older sighting never moves the clock back. */
export function recordActivity(name: string, at = Date.now()): void {
  const prev = lastActivity.get(name);
  if (prev === undefined || at > prev) lastActivity.set(name, at);
}
export function lastActivityMs(name: string): number | undefined {
  return lastActivity.get(name);
}

export interface WakeResult {
  found: boolean;
  ready: boolean;
  /** It had no running copy, so this wake started one (a real cold start). */
  woke: boolean;
}

const POLL_MS = 250;
const WAIT_MS = 25_000;

/** Scale a cold service up to its target and wait (up to ~25s) for it to be live. */
export async function wake(name: string, orgId: string): Promise<WakeResult> {
  const found = findWakeable(store, name, orgId);
  if (!found) return { found: false, ready: false, woke: false };
  const node = hub.managerNode(orgId);
  if (!node) return { found: true, ready: false, woke: false };
  const woke = found.running < 1;
  if (woke) {
    await hub.dispatch(node, 'service.scale', { service: name, replicas: found.target }).catch(() => undefined);
  }
  for (let waited = 0; waited <= WAIT_MS; waited += POLL_MS) {
    if ((findWakeable(store, name, orgId)?.running ?? 0) >= 1) return { found: true, ready: true, woke };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return { found: true, ready: false, woke };
}

/** One wake in flight per service: requests that arrive meanwhile wait on it. */
const inflight = new Map<string, Promise<WakeResult>>();

async function wakeAndServe(name: string, orgId: string, startedAt: number): Promise<WakeResult> {
  const r = await wake(name, orgId);
  if (r.ready) {
    // Service is warm now: re-render ingress so its domain flips from THIS activator
    // back to a direct upstream BEFORE we 307 the caller back (closes the redirect-loop
    // window where a warm service is still routed through the activator).
    await reapplyIngressForOrg({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId).catch(() => undefined);
    if (r.woke) recordWakeTime(orgId, name, Date.now() - startedAt);
  }
  return r;
}

function sharedWake(name: string, orgId: string, startedAt: number): Promise<WakeResult> {
  const k = `${orgId}\u0000${name}`;
  const running = inflight.get(k);
  if (running) return running;
  const run = wakeAndServe(name, orgId, startedAt).finally(() => inflight.delete(k));
  inflight.set(k, run);
  return run;
}

export const activatorApp = new Hono();

activatorApp.all('/:service/:token', async (c) => {
  const startedAt = Date.now();
  const name = c.req.param('service');
  // Same answer for "no such service" and "bad token": no oracle for which names exist.
  const orgId = orgForWakeToken(store, name, c.req.param('token'));
  if (!orgId) return c.json({ error: 'unknown service' }, 404);
  recordActivity(name);
  const { found, ready } = await sharedWake(name, orgId, startedAt);
  if (!found) return c.json({ error: 'unknown service' }, 404);
  const back = safeReturn(c.req.query('return'), c.req.header('host'));
  if (back) return c.redirect(back, 307);
  return c.json({ service: name, ready });
});

// The pre-signing path: an edge still on an old config hits this until its next
// render (the cold-route reconcile re-renders on the controller's first tick).
activatorApp.all('/:service', (c) => c.json({ error: 'wake links are signed: the edge renders them' }, 404));
