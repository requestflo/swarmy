import {
  MINUTE_MS,
  SCALE_TO_ZERO_IDLE_LABEL,
  SCALE_TO_ZERO_LABEL,
} from '@swarmy/core';
import { readRoutes } from '@swarmy/trpc';
import { hub, store } from '../gateway';
import { lastActivityMs, recordActivity } from '../activator';
import { lastEdgeRequestMs, sleepDecision } from './scale-to-zero.core';

/**
 * Idle sleeper (epic #4A): scale `swarmy.scaleToZero.enabled` services to 0 once
 * they've had no traffic for their idle window. "Traffic" = the activator's last
 * request time OR the edge's last request to one of the service's routed hosts
 * (the hub's EdgeTrafficRing): once warm, the edge routes straight to the service
 * and the activator sees nothing more. A freshly-enabled service with no recorded
 * activity gets a now() baseline so it isn't slept instantly. Pure Docker-truth:
 * reads the live inventory from the hub, dispatches a scale to the org's manager.
 * No DB. The decision is pure (`scale-to-zero.core.ts`).
 */
export function startScaleToZero(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    const ring = hub.edgeTraffic();
    for (const orgId of orgIds) {
      const { services } = hub.liveInventory(orgId);
      for (const s of services) {
        if (s.labels[SCALE_TO_ZERO_LABEL] !== 'true') continue;
        const desired = s.desiredReplicas ?? 0;
        if (s.runningReplicas === 0 && desired === 0) continue; // already asleep

        const now = Date.now();
        const idleMs = (Number(s.labels[SCALE_TO_ZERO_IDLE_LABEL]) || 300) * 1000;
        const hosts = new Set(readRoutes(s.labels).map((r) => r.host));
        const edgeAt = hosts.size
          ? lastEdgeRequestMs(ring.cells(orgId, now - idleMs - MINUTE_MS, now), hosts, now)
          : undefined;
        const decision = sleepDecision({ now, idleMs, activatorAt: lastActivityMs(s.name), edgeAt });
        if (decision === 'start-clock') {
          recordActivity(s.name); // first sight → start the clock now
          continue;
        }
        if (decision === 'sleep') {
          const node = hub.managerNode(orgId);
          if (node) {
            void hub
              .dispatch(node, 'service.scale', { service: s.name, replicas: 0 })
              .catch(() => undefined);
          }
        }
      }
    }
  }, 10_000);
  return () => clearInterval(timer);
}
