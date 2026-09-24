/**
 * Daily Trivy DB refresh (self-reliance B6) — the controller side of
 * `./trivy-db.ts`. Once a day, every node that scans (online Builder-role
 * nodes; else the one node `resolveScanNode` would pick) downloads the DB into
 * its `swarmy-trivy-cache` volume, so scans on that node never fetch it
 * themselves. A failed refresh is not an error anywhere: the next scan uses the
 * cached DB and flags it stale (admission warns, never blocks).
 */
import { registryConfigs } from './apps.repo';
import { allOrgRows } from './backups.repo';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { hasBuilderLabel } from '@swarmy/core';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { AgentHub } from '../hub/types';
import { TRIVY_IMAGE } from './registryPolicy.service';
import { TRIVY_DB_REFRESHED_MARKER, renderTrivyRefreshScript, trivyCacheBind } from './trivy-db';

export interface TrivyRefreshResult {
  nodeId: string;
  ok: boolean;
  error?: string;
}

/** Pure: which of an org's nodes refresh — every online builder, else the first online node. */
export function pickTrivyRefreshNodes(
  nodes: Array<{ id: string; labels: Record<string, string> | undefined; online: boolean }>,
): string[] {
  const online = nodes.filter((n) => n.online);
  const builders = online.filter((n) => hasBuilderLabel(n.labels));
  if (builders.length) return builders.map((n) => n.id);
  return online.length ? [online[0]!.id] : [];
}

export async function refreshTrivyDbAllOrgs(deps: { db: DB; hub: AgentHub; auth: Auth }): Promise<TrivyRefreshResult[]> {
  // Only orgs that scan: the in-swarm registry is enabled (scans run on built images).
  const orgs = await allOrgRows(deps, registryConfigs, { where: { enabled: true } });
  const out: TrivyRefreshResult[] = [];
  const done = new Set<string>();
  for (const { orgId } of orgs) {
    const nodes = await deps.db.node.findMany({ where: { orgId }, select: { id: true } });
    const pick = pickTrivyRefreshNodes(
      nodes.map((n) => ({ id: n.id, labels: deps.hub.nodeInfoFor(n.id)?.labels, online: deps.hub.isOnline(n.id) })),
    );
    for (const nodeId of pick) {
      if (done.has(nodeId)) continue;
      done.add(nodeId);
      try {
        const res = await deps.hub.dispatch<RunOnceResult>(
          nodeId,
          'container.runOnce',
          {
            // The hub decorator swaps in the mirrored copy when there is one.
            image: TRIVY_IMAGE,
            entrypoint: ['/bin/sh', '-c'],
            cmd: [renderTrivyRefreshScript()],
            binds: [trivyCacheBind()],
            networks: ['host'],
            timeoutMs: 5 * 60_000,
          },
          { timeoutMs: 6 * 60_000 },
        );
        const ok = res.exitCode === 0 && res.output.includes(TRIVY_DB_REFRESHED_MARKER);
        out.push(ok ? { nodeId, ok } : { nodeId, ok, error: res.output.slice(-500) });
      } catch (e) {
        out.push({ nodeId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return out;
}
