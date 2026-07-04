import { bundleSignature } from '@swarmy/dns';
import type { ApplyDnsResult, DnsSnapshotBundle } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { buildDnsSnapshotBundle } from './dns-snapshot.service';
import { dnsAdminToken, DNS_ADMIN_PORT } from './dns-deploy.service';

/**
 * Snapshot push — fan `dns.apply` out to every online DNS node (invariant #4:
 * push, never config rotation). Best-effort per node: offline nodes catch up
 * on the next reconcile tick, and a freshly-booted swarmy-dns self-recovers
 * from its persisted snapshot anyway.
 */

export interface PushResult {
  signature: string;
  zones: number;
  pushed: string[];
  failed: Array<{ nodeId: string; error: string }>;
  skipped: boolean;
}

/** Nodes that (should) run swarmy-dns right now: online ingress+outlet. */
export function dnsNodeIds(ctx: OrgContext): string[] {
  const outlet = new Set(ctx.hub.nodesByRole(ctx.activeOrgId, 'outlet'));
  return ctx.hub
    .nodesByRole(ctx.activeOrgId, 'ingress')
    .filter((id) => outlet.has(id) && ctx.hub.isOnline(id));
}

export async function pushDnsBundle(
  ctx: OrgContext,
  bundle: DnsSnapshotBundle,
): Promise<PushResult> {
  const token = dnsAdminToken(ctx.activeOrgId);
  const nodes = dnsNodeIds(ctx);
  const pushed: string[] = [];
  const failed: Array<{ nodeId: string; error: string }> = [];

  await Promise.all(
    nodes.map(async (nodeId) => {
      try {
        await ctx.hub.dispatch<ApplyDnsResult>(nodeId, 'dns.apply', {
          bundle,
          adminUrl: `http://127.0.0.1:${DNS_ADMIN_PORT}`,
          adminToken: token,
        });
        pushed.push(nodeId);
      } catch (e) {
        failed.push({ nodeId, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  return {
    signature: bundleSignature(bundle),
    zones: bundle.zones.length,
    pushed,
    failed,
    skipped: false,
  };
}

/**
 * Compose + push in one step (the `applyNow` path and the reconcile worker
 * body). `lastSignature` short-circuits unchanged content — pass the previous
 * tick's signature to make the worker cheap; omit to force a push.
 */
export async function composeAndPushDns(
  ctx: OrgContext,
  lastSignature?: string,
): Promise<PushResult> {
  const { bundle } = await buildDnsSnapshotBundle(ctx);
  const signature = bundleSignature(bundle);
  if (lastSignature !== undefined && signature === lastSignature) {
    return { signature, zones: bundle.zones.length, pushed: [], failed: [], skipped: true };
  }
  if (bundle.zones.length === 0) {
    return { signature, zones: 0, pushed: [], failed: [], skipped: true };
  }
  return pushDnsBundle(ctx, bundle);
}
