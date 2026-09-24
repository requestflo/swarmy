// Custom-domain verification + certificate status worker (+ automatic app
// addresses: stamps `<service>-<stack>.<edge-ip>.sslip.io` on a qualifying
// service's first deploy — pure planner `planAutoAddresses`). Per org with ingress
// enabled, every 30s: plan which routed hosts are DUE (pure
// `planDomainChecks` — fast while waiting for DNS, backing off to hourly for
// a domain nobody pointed yet, 10 min once active), look them up on public
// resolvers over DNS-over-HTTPS, TLS-probe the edges once DNS verifies, and
// persist the observations. When a host flips from "waiting for DNS" to
// verified the edge is re-rendered at once (ingress-reconcile would pick it up
// within 10s anyway — the signature covers the gated route set).
// All logic lives in @swarmy/trpc `reconcileDomainChecksOrg`; this file only
// ticks, loops orgs and never overlaps. Steady state: no DNS/TLS traffic for
// hosts that are not due, zero agent commands.
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { reconcileAutoAddressesForOrg, reconcileDomainChecksOrg } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 30_000;

export function startDomainVerify(): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // DoH + TLS probes can outrun the interval — never overlap
    running = true;
    try {
      const deps = { db: prisma, hub, auth: authRegistry.getAuth() };
      const orgs = await prisma.ingressConfig
        .findMany({ where: { enabled: true }, select: { orgId: true } })
        .catch(() => [] as { orgId: string }[]);
      for (const { orgId } of orgs) {
        // One org's failure (DB blip, resolver outage) never stalls the rest.
        // Auto addresses first: a service's first deploy gets its sslip.io route
        // stamped (ingress-reconcile renders it); the checks then report its cert.
        await reconcileAutoAddressesForOrg(deps, orgId).catch(() => undefined);
        await reconcileDomainChecksOrg(deps, orgId).catch(() => undefined);
      }
    } finally {
      running = false;
    }
  };
  // Defer: edge IPs come from live node labels, which need nodes reconnected.
  const kickoff = setTimeout(() => void tick(), 45_000);
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
