import { Hono } from 'hono';
import { SCALE_TO_ZERO_TARGET_LABEL } from '@swarmy/core';
import { hub, store } from './gateway';

/**
 * Scale-to-zero activator (epic #4B).
 *
 * Ingress routes a cold (0-replica) service's traffic here. We record the request
 * (the idle-tracking signal the sleeper uses), scale the service up to its target,
 * wait for a task to come live, then 307 the caller back so ingress serves it
 * directly. Also reachable directly at `/_wake/:service` for the UI's "Wake" button
 * and for testing.
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

function findService(name: string): { orgId: string; running: number; target: number } | undefined {
  for (const [nodeId, services] of store.serviceInfo) {
    const svc = services.find((s) => s.name === name);
    if (svc) {
      const orgId = store.nodeOrg.get(nodeId);
      if (orgId) {
        return {
          orgId,
          running: svc.runningReplicas,
          target: Number(svc.labels[SCALE_TO_ZERO_TARGET_LABEL]) || 1,
        };
      }
    }
  }
  return undefined;
}

/** Scale a cold service up to its target and wait (up to ~25s) for it to be live. */
export async function wake(name: string): Promise<{ found: boolean; ready: boolean }> {
  const found = findService(name);
  if (!found) return { found: false, ready: false };
  const node = hub.managerNode(found.orgId);
  if (!node) return { found: true, ready: false };
  if (found.running < 1) {
    await hub.dispatch(node, 'service.scale', { service: name, replicas: found.target }).catch(() => undefined);
  }
  for (let i = 0; i < 25; i++) {
    if ((findService(name)?.running ?? 0) >= 1) return { found: true, ready: true };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { found: true, ready: false };
}

export const activatorApp = new Hono();

activatorApp.all('/:service', async (c) => {
  const name = c.req.param('service');
  recordActivity(name);
  const { found, ready } = await wake(name);
  if (!found) return c.json({ error: 'unknown service' }, 404);
  const back = c.req.query('return');
  if (back) return c.redirect(back, 307);
  return c.json({ service: name, ready });
});
