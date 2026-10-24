/**
 * "Networks are too big for the mesh" (Mesh settings). Each agent's 20 s
 * `meshState` carries its WireGuard interface MTU and the overlays its Docker
 * knows (additive fields); they are held here, process-local, like the live
 * peer map (telemetry, never stored). The check itself is pure
 * (`checkOverlayMtu`, @swarmy/core). Nothing here changes a network: an
 * existing overlay's MTU is fixed at creation and swarmy has no safe way to
 * recreate one under running apps, so the page shows the manual step. New
 * overlays swarmy creates already get the right option (`overlayDriverOptions`).
 */
import { checkOverlayMtu, meshLinkMtu, type MeshMtuCheck, type OverlayMtuSample } from '@swarmy/core';
import type { OrgContext } from '../context';
import { meshConfigRepo } from './mesh-config.repo';
import { nodesOnMesh } from './mesh-onmesh';

export interface MeshMtuReport {
  iface: string | null;
  linkMtu: number | null;
  /** `null` = this node didn't list its overlays (Docker unreachable). */
  overlays: OverlayMtuSample[] | null;
  at: number;
}

/** A report counts for two minutes (six `meshState` ticks). */
const FRESH_MS = 120_000;

export class MeshMtuLiveStore {
  private readonly byOrg = new Map<string, Map<string, MeshMtuReport>>();

  /** Fold one `meshState`; a report from an older agent (no MTU fields) is ignored. */
  report(
    orgId: string,
    nodeId: string,
    p: { interface?: string; interfaceMtu?: number; overlays?: OverlayMtuSample[] },
    at = Date.now(),
  ): void {
    if (p.interfaceMtu === undefined && p.overlays === undefined) return;
    const m = this.byOrg.get(orgId) ?? new Map<string, MeshMtuReport>();
    m.set(nodeId, { iface: p.interface ?? null, linkMtu: p.interfaceMtu ?? null, overlays: p.overlays ?? null, at });
    this.byOrg.set(orgId, m);
  }

  fresh(orgId: string, now = Date.now()): MeshMtuReport[] {
    return [...(this.byOrg.get(orgId)?.values() ?? [])].filter((r) => now - r.at <= FRESH_MS);
  }

  clear(): void {
    this.byOrg.clear();
  }
}

export const meshMtuLive = new MeshMtuLiveStore();

/**
 * Pure: every node's report → one check input. The smallest tunnel binds; the
 * overlays are cluster-wide, so they are merged by name (a disagreement keeps
 * the biggest option, the pessimistic one). With no readable interface MTU the
 * driver's known default stands in, but only once some node listed overlays.
 */
export function mergeMtuReports(
  reports: readonly MeshMtuReport[],
  fallbackLinkMtu?: number,
): { iface: string | null; linkMtu: number | null; overlays: OverlayMtuSample[] | null } {
  const links = reports.filter((r) => r.linkMtu).map((r) => r.linkMtu!);
  const lists = reports.filter((r) => r.overlays).map((r) => r.overlays!);
  const byName = new Map<string, OverlayMtuSample>();
  for (const o of lists.flat()) {
    const prev = byName.get(o.name);
    if (!prev || (o.mtu ?? 1500) > (prev.mtu ?? 1500)) byName.set(o.name, o);
  }
  const overlays = lists.length ? [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) : null;
  const linkMtu = links.length ? Math.min(...links) : overlays ? (fallbackLinkMtu ?? null) : null;
  return { iface: reports.find((r) => r.iface)?.iface ?? null, linkMtu, overlays };
}

export interface MeshMtuView extends MeshMtuCheck {
  /** Per too-big network: the services on it now (live inventory), i.e. what a recreate takes offline. */
  services: Record<string, string[]>;
  /** Servers whose report counted. */
  reporting: number;
}

/** The finding for Mesh settings; `null` when the swarm doesn't ride the mesh (overlay size can't bite). */
export async function getMeshMtuCheck(ctx: OrgContext): Promise<MeshMtuView | null> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  if (!row.enabled || row.driver === 'NONE') return null;
  if ((await nodesOnMesh(ctx)).length === 0) return null;
  const reports = meshMtuLive.fresh(ctx.activeOrgId);
  const check = checkOverlayMtu(mergeMtuReports(reports, meshLinkMtu(row.driver)));
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services;
  const services: Record<string, string[]> = {};
  for (const f of check.tooBig) {
    services[f.name] = live
      .filter((s) => s.networks.some((n) => n.name === f.name))
      .map((s) => s.name)
      .sort();
  }
  return { ...check, services, reporting: reports.length };
}
