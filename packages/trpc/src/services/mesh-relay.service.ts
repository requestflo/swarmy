/**
 * Relays on edges (plans/epic-self-hosted-mesh-and-fleets.md §2.5, M3): the
 * controller glue. The plan and the decision are pure in `@swarmy/mesh`
 * (`planEdgeRelays`, `decideRelays`); this reads the live inputs, sends the
 * agent commands and hands the relay list back to the control-plane
 * reconcile (mesh-control.service step 4b), which persists it in the managed
 * doc and renders it into NetBird's config.
 *
 * Inputs are all live: edges are nodes labelled `swarmy.node.ingress` with a
 * public IPv4 (last-known nodes count, so a blip never churns the list), mesh
 * addresses come from the peer map, relay health from `meshState.relay`.
 */
import { isPublicIpv4 } from '@swarmy/core';
import type { MeshRelayStatus } from '@swarmy/core/protocol';
import {
  NETBIRD_RELAY_IMAGE_PINNED,
  decideRelays,
  planEdgeRelays,
  type ExternalRelays,
  type PlannedRelay,
  type RelayEdgeInput,
} from '@swarmy/mesh';
import type { OrgContext } from '../context';
import { getAutoAddressBase } from './auto-address-base.service';
import type { ManagedControlPlane } from './mesh-control.service';
import { isMeshCidr } from './mesh-onmesh';
import { meshPeers } from './mesh-peers';
import { meshRelayLive } from './mesh-relay-live';
import { publicIpFromLabels } from './node.service';

/** Wanted: switched on, NetBird behind swarmy's edge, and past the TLS handover. */
export function relaysWanted(m: Pick<ManagedControlPlane, 'relaysOnEdges' | 'tls' | 'bootstrapTls' | 'handedOverAt'>): boolean {
  return Boolean(m.relaysOnEdges) && m.tls.mode === 'edge' && (!m.bootstrapTls || Boolean(m.handedOverAt));
}

/** Edge nodes that can host a relay. */
export function relayEdges(ctx: OrgContext): RelayEdgeInput[] {
  const out: RelayEdgeInput[] = [];
  for (const nodeId of ctx.hub.nodesByRole(ctx.activeOrgId, 'ingress')) {
    const info = ctx.hub.nodeInfoFor(nodeId);
    const publicIp = publicIpFromLabels(info?.labels);
    if (!info || !publicIp || !isPublicIpv4(publicIp)) continue;
    const advertised = info.addr?.replace(/:\d+$/, '');
    const meshIp = meshPeers.get(nodeId)?.meshIp ?? (isMeshCidr(advertised) ? advertised! : null);
    out.push({ nodeId, hostname: info.hostname, publicIp, meshIp });
  }
  return out;
}

/** `base` = the org's wildcard-IP base (its cluster zone, else sslip.io); read live when omitted. */
export async function plannedRelays(ctx: OrgContext, m: ManagedControlPlane, base?: string): Promise<PlannedRelay[]> {
  if (!relaysWanted(m) || m.tls.mode !== 'edge') return [];
  return planEdgeRelays(relayEdges(ctx), base ?? (await getAutoAddressBase(ctx)).effective, m.tls.publicPort ?? 443);
}

/** The edge vhosts that front the relays (same on every edge: upstream = the relay node's mesh address). */
export async function relayVhostsFor(
  ctx: OrgContext,
  m: ManagedControlPlane,
): Promise<{ domain: string; upstream: string; targetPath: string; kind: 'mesh-control'; tls: 'auto' }[]> {
  return (await plannedRelays(ctx, m)).map((r) => ({ domain: r.host, upstream: r.upstream, targetPath: '/', kind: 'mesh-control' as const, tls: 'auto' as const }));
}

export interface EdgeRelayReconcile {
  /** The relay list the control-plane config should carry now. */
  next: ExternalRelays | null;
  steps: string[];
}

/**
 * Converge the relays and say what NetBird should list. Stops go FIRST: on
 * the way back the control node's STUN port must be free before NetBird
 * restarts with its own. A failed stop there keeps the current list.
 */
export async function reconcileEdgeRelays(
  ctx: OrgContext,
  m: ManagedControlPlane,
  opts: { authSecret: string; controlNodeId: string | null; controlRunsExternal: boolean; base?: string },
): Promise<EdgeRelayReconcile> {
  const orgId = ctx.activeOrgId;
  const planned = await plannedRelays(ctx, m, opts.base);
  const reports = meshRelayLive.all(orgId).map((r) => ({ nodeId: r.nodeId, ...r.status }));
  const d = decideRelays({
    wanted: relaysWanted(m),
    planned,
    controlNodeId: opts.controlNodeId,
    active: m.relays ? { addresses: m.relays.addresses, stuns: m.relays.stuns } : null,
    controlRunsExternal: opts.controlRunsExternal,
    reports,
    image: NETBIRD_RELAY_IMAGE_PINNED,
    authSecret: opts.authSecret,
  });
  const steps: string[] = [];
  let keep = false;
  for (const nodeId of d.stop) {
    try {
      if (!ctx.hub.isOnline(nodeId)) throw new Error('offline');
      await ctx.hub.dispatch(nodeId, 'mesh.relay', { action: 'stop' }, { timeoutMs: 60_000 });
      meshRelayLive.forget(orgId, nodeId);
      steps.push(`relay stopped on ${nodeId}`);
    } catch (e) {
      if (nodeId === opts.controlNodeId) keep = true;
      steps.push(`relay stop on ${nodeId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const a of d.apply) {
    if (!ctx.hub.isOnline(a.nodeId)) continue;
    try {
      const st = await ctx.hub.dispatch<MeshRelayStatus>(a.nodeId, 'mesh.relay', { action: 'apply', spec: a.spec }, { timeoutMs: 120_000 });
      meshRelayLive.report(orgId, a.nodeId, st);
      steps.push(`relay ${a.spec.exposedAddress} applied (stun ${a.spec.stun ? 'on' : 'off'})`);
    } catch (e) {
      steps.push(`relay apply on ${a.nodeId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const current = m.relays ? { addresses: m.relays.addresses, stuns: m.relays.stuns } : null;
  return { next: keep && !d.next ? current : d.next, steps };
}

/** For the control-plane card: each planned relay with its live status. */
export async function relayCard(ctx: OrgContext, m: ManagedControlPlane): Promise<{
  enabled: boolean;
  active: boolean;
  edges: { hostname: string; address: string; running: boolean; healthy: boolean }[];
}> {
  const planned = await plannedRelays(ctx, m);
  return {
    enabled: Boolean(m.relaysOnEdges),
    active: Boolean(m.relays),
    edges: planned.map((r) => {
      const st = meshRelayLive.get(ctx.activeOrgId, r.nodeId)?.status;
      return { hostname: r.hostname, address: r.address, running: Boolean(st?.running), healthy: Boolean(st?.healthy) };
    }),
  };
}
