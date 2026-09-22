// Ingress reconcile worker. Per org, keeps the edge converged on live Docker truth:
// - routes read off service labels (incl. ones a blueprint/compose deploy wrote
//   directly, which no mutation ever re-applied before) get rendered + pushed;
// - scale-to-zero domains flip activator <-> direct as services sleep/wake (the
//   activator also force-reapplies the instant it wakes a service; this is the
//   safety net for the SLEEP direction and any missed transition);
// - a freshly (re)scheduled Caddy task gets its config the tick it appears;
// - Caddy enabled but its controller service missing -> re-deployed.
// Pure logic lives in @swarmy/trpc `reconcileIngressOrg` (signature-gated: a
// steady state sends zero commands); this file only ticks, loops orgs and holds
// the per-org last signature. No DB writes.
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { reconcileIngressOrg } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 10_000; // matches the scale-to-zero sleeper cadence

export function startIngressReconcile(): () => void {
  const lastSignature = new Map<string, string>();
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // pushes can outrun the interval — never overlap ticks
    running = true;
    try {
      const deps = { db: prisma, hub, auth: authRegistry.getAuth() };
      const orgs = await prisma.organization
        .findMany({ select: { id: true } })
        .catch(() => [] as { id: string }[]);
      for (const org of orgs) {
        const res = await reconcileIngressOrg(deps, org.id, lastSignature.get(org.id)).catch(
          () => null,
        );
        if (!res) continue;
        if (res.signature) lastSignature.set(org.id, res.signature);
        else lastSignature.delete(org.id);
      }
    } finally {
      running = false;
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
