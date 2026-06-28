import {
  SCALE_TO_ZERO_IDLE_LABEL,
  SCALE_TO_ZERO_LABEL,
} from '@swarmy/core';
import { hub, store } from '../gateway';
import { lastActivityMs, recordActivity } from '../activator';

/**
 * Idle sleeper (epic #4A): scale `swarmy.scaleToZero.enabled` services to 0 once
 * they've had no traffic for their idle window. "Traffic" = the activator's last
 * request time; a freshly-enabled service with no recorded activity gets a now()
 * baseline so it isn't slept instantly. Pure Docker-truth: reads the live inventory
 * from the hub, dispatches a scale to the org's manager. No DB.
 */
export function startScaleToZero(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) {
      const { services } = hub.liveInventory(orgId);
      for (const s of services) {
        if (s.labels[SCALE_TO_ZERO_LABEL] !== 'true') continue;
        const desired = s.desiredReplicas ?? 0;
        if (s.runningReplicas === 0 && desired === 0) continue; // already asleep

        const idleMs = (Number(s.labels[SCALE_TO_ZERO_IDLE_LABEL]) || 300) * 1000;
        const last = lastActivityMs(s.name);
        if (last === undefined) {
          recordActivity(s.name); // first sight → start the clock now
          continue;
        }
        if (Date.now() - last > idleMs) {
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
