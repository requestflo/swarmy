import type { DomainResolvers } from '../types';
import { SCALE_TO_ZERO } from './inventory';

/**
 * Config › Scaling's demo world: sleep when idle lives on the service (the
 * `swarmy.scaleToZero.*` labels in production), so `services.get` and
 * `inventory.get` agree after `services.setScaleToZero`. cdn-edge and
 * cloudflared start with it on, 15 minutes idle.
 */
export const scaling: DomainResolvers = {
  seed: (store) => {
    for (const sv of store.services) {
      if (SCALE_TO_ZERO.has(sv.name)) {
        sv.scaleToZero = { enabled: true, targetReplicas: Math.max(1, sv.replicas.desired), idleSeconds: 900 };
      }
    }
  },
  handlers: {
    'services.setScaleToZero': (i, s) => {
      const b = i as { id: string; enabled: boolean; targetReplicas?: number; idleSeconds?: number };
      const sv = s.services.find((x) => x.id === b.id);
      if (!sv) throw new Error(`service "${b.id}" not found`);
      sv.scaleToZero = b.enabled
        ? {
            enabled: true,
            targetReplicas: b.targetReplicas ?? Math.max(1, sv.replicas.desired || 1),
            idleSeconds: b.idleSeconds ?? 300,
          }
        : { enabled: false, targetReplicas: Math.max(1, sv.replicas.desired || 1), idleSeconds: 300 };
      return { id: sv.id, ok: true as const };
    },
  },
};
