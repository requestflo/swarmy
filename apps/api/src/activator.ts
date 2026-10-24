import { Hono } from 'hono';
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { reapplyIngressForOrg } from '@swarmy/trpc';
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
 */
const lastActivity = new Map<string, number>();

export function recordActivity(name: string): void {
  lastActivity.set(name, Date.now());
}
export function lastActivityMs(name: string): number | undefined {
  return lastActivity.get(name);
}

/** Scale a cold service up to its target and wait (up to ~25s) for it to be live. */
export async function wake(name: string, orgId: string): Promise<{ found: boolean; ready: boolean }> {
  const found = findWakeable(store, name, orgId);
  if (!found) return { found: false, ready: false };
  const node = hub.managerNode(orgId);
  if (!node) return { found: true, ready: false };
  if (found.running < 1) {
    await hub.dispatch(node, 'service.scale', { service: name, replicas: found.target }).catch(() => undefined);
  }
  for (let i = 0; i < 25; i++) {
    if ((findWakeable(store, name, orgId)?.running ?? 0) >= 1) return { found: true, ready: true };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { found: true, ready: false };
}

export const activatorApp = new Hono();

activatorApp.all('/:service/:token', async (c) => {
  const name = c.req.param('service');
  // Same answer for "no such service" and "bad token": no oracle for which names exist.
  const orgId = orgForWakeToken(store, name, c.req.param('token'));
  if (!orgId) return c.json({ error: 'unknown service' }, 404);
  recordActivity(name);
  const { found, ready } = await wake(name, orgId);
  if (!found) return c.json({ error: 'unknown service' }, 404);
  if (ready) {
    // Service is warm now: re-render ingress so its domain flips from THIS activator
    // back to a direct upstream BEFORE we 307 the caller back (closes the redirect-loop
    // window where a warm service is still routed through the activator).
    await reapplyIngressForOrg({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId).catch(() => undefined);
  }
  const back = safeReturn(c.req.query('return'), c.req.header('host'));
  if (back) return c.redirect(back, 307);
  return c.json({ service: name, ready });
});

// The pre-signing path: an edge still on an old config hits this until its next
// render (the cold-route reconcile re-renders on the controller's first tick).
activatorApp.all('/:service', (c) => c.json({ error: 'wake links are signed: the edge renders them' }, 404));
