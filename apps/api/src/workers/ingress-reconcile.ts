// Scale-to-zero ingress reconcile worker (epic #4B). Watches live Docker state per
// org and re-renders ingress when a domain's backing service crosses 0<->N replicas:
// asleep (0 running, scale-to-zero) -> domain flips to the activator (wake-on-request);
// warmed up -> flips back to a direct upstream. The activator also force-reapplies the
// instant it wakes a service (activator.ts), so this worker is the safety net that
// catches the SLEEP (warm->cold) direction and any missed transition. Pure Docker-truth:
// diff/render/dispatch lives in @swarmy/trpc reconcileColdIngress; the worker just holds
// the per-org last-cold-set cache and ticks. No DB writes.
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { reconcileColdIngress } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 10_000; // matches the scale-to-zero sleeper cadence

export function startIngressReconcile(): () => void {
  const lastCold = new Map<string, string[]>();
  const tick = async (): Promise<void> => {
    const deps = { db: prisma, hub, auth: authRegistry.getAuth() };
    const orgs = await prisma.organization
      .findMany({ select: { id: true } })
      .catch(() => [] as { id: string }[]);
    for (const org of orgs) {
      const prev = lastCold.get(org.id) ?? [];
      const next = await reconcileColdIngress(deps, org.id, prev).catch(() => prev);
      lastCold.set(org.id, next);
    }
  };
  // Defer the first run so the gateway/hub is warm and nodes have reconnected.
  const kickoff = setTimeout(() => void tick(), 30_000);
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
