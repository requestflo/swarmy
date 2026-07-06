/**
 * Geo-DNS reconcile worker ("swarmy is the nameserver").
 *
 * Every tick, per org with geo-dns enabled: compose the zone snapshot bundle
 * from live truth (ingress hostnames, node roles/regions/public-ips, health),
 * signature-gate it, and push `dns.apply` to every online DNS node — plus the
 * provider sync for cloudflare/route53 zones. Every CONVERGE_EVERY ticks it
 * also re-converges the swarmy-dns global service (spec drift, new orgs).
 *
 * ALL logic lives in @swarmy/trpc (`reconcileDnsOrg`) and @swarmy/dns — this
 * file is only a scheduler. The old worker inlined a copy of the renderer and
 * drifted; that class of bug is structurally gone (geo-edge-routing skill,
 * invariant #6).
 */
import { prisma } from '@swarmy/db';
import { reconcileDnsOrg } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 15_000;
const CONVERGE_EVERY = 20; // ≈ every 5 minutes

export function startDnsReconcile(): () => void {
  // orgId → (nodeId → last bundle signature that node ACKED). Per-node, so a
  // node that failed an apply or joined after the last content change keeps
  // getting pushed until it confirms — see composeAndPushDns.
  const acked = new Map<string, Map<string, string>>();
  let tick = 0;
  let running = false;

  const run = async (): Promise<void> => {
    if (running) return; // skip overlapping ticks (slow pushes / many orgs)
    running = true;
    tick += 1;
    try {
      const orgs = await prisma.geoDnsConfig.findMany({
        where: { enabled: true },
        select: { orgId: true },
      });
      for (const { orgId } of orgs) {
        try {
          const orgAcked = acked.get(orgId) ?? new Map<string, string>();
          acked.set(orgId, orgAcked);
          const result = await reconcileDnsOrg({
            db: prisma,
            hub,
            orgId,
            acked: orgAcked,
            converge: tick % CONVERGE_EVERY === 1,
          });
          for (const nodeId of result.push.pushed) orgAcked.set(nodeId, result.push.signature);
          if (!result.push.skipped) {
            console.log(
              `[dns-reconcile] org=${orgId} pushed ${result.push.zones} zone(s) to ${result.push.pushed.length} node(s)` +
                (result.push.failed.length ? ` (${result.push.failed.length} failed)` : '') +
                (result.providerSynced ? `, provider-synced ${result.providerSynced}` : ''),
            );
          }
        } catch (err) {
          console.error(`[dns-reconcile] org=${orgId} failed:`, err);
        }
      }
    } catch (err) {
      console.error('[dns-reconcile] tick failed:', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), TICK_MS);
  void run();
  return () => clearInterval(timer);
}
