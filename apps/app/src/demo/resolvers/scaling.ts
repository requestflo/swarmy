import { wakeTimesView, type WakeSample, type WakeTimesView } from '@swarmy/core';
import type { DomainResolvers } from '../types';
import { SCALE_TO_ZERO } from './inventory';

const MIN = 60_000;

/** The wakes the activator would have timed: about two seconds, one slow image pull. */
function demoWakes(name: string, now = Date.now()): WakeSample[] {
  if (!SCALE_TO_ZERO.has(name)) return [];
  const ms = name === 'cloudflared' ? [3_400, 3_100, 3_900] : [2_100, 1_900, 2_300, 2_000, 6_800, 2_200];
  return ms.map((m, i) => ({ at: now - (ms.length - i) * 47 * MIN, ms: m }));
}

/**
 * Config › Scaling's demo world: sleep when idle lives on the service (the
 * `swarmy.scaleToZero.*` labels in production), so `services.get` and
 * `inventory.get` agree after `services.setScaleToZero`. cdn-edge and
 * cloudflared start with it on, 15 minutes idle; `services.wakeTimes` says
 * what their wakes took (a service switched on here has none yet).
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
    'services.wakeTimes': (i, s): WakeTimesView => {
      const sv = s.services.find((x) => x.id === (i as { id: string }).id);
      if (!sv) throw new Error('service not found');
      return wakeTimesView(demoWakes(sv.name));
    },
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
