/**
 * Registry topology reconcile (security review M16), ticked every minute by
 * the system-image-mirror worker: move the registry and the pull-through cache
 * off the routing mesh once every node forwards loopback (the rule is
 * `registryTopologyFor`, registry-topology.ts), and keep them there.
 *
 * This is the migration path for clusters that still publish on the mesh.
 * The registry moves with the GC window's own spec, pinned to the node that
 * holds its volume and stopping the old task first, so its data and the
 * system-image mirror labels (trusted only on that node) stay put. The cache
 * moves through `ensureCache`, which every other cache deploy also goes through.
 *
 * Signature-gated per org (wanted topology + each service's live one): a
 * steady state sends no command, and a move already sent is not re-sent while
 * the hub snapshot catches up. A skip stores no signature, so the next tick
 * tries again. System-actor audited.
 */
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { registryConfigs } from './apps.repo';
import { allOrgRows } from './backups.repo';
import { writeAudit } from './audit.service';
import { systemContext } from './cicd.service';
import { locateRegistry } from './registry-gc.live';
import { registryIsReadOnly, registryMaintenanceSpec } from './registry-gc.spec';
import { cacheHubAuthOf, ensureCache } from './system-images.service';
import {
  liveRegistryServices,
  liveRegistryTopology,
  registryTopologyFor,
  registryTopologySignature,
  type RegistryTopology,
} from './registry-topology';

type Deps = { db: DB; hub: AgentHub; auth: Auth };

export interface RegistryTopologyResult {
  orgId: string;
  topology?: RegistryTopology;
  moved: Array<'registry' | 'cache'>;
  skipped?: string;
  error?: string;
  /** Store when present (the worker's per-org gate). */
  signature?: string;
}

export async function convergeRegistryTopologyForOrg(deps: Deps, orgId: string, last?: string): Promise<RegistryTopologyResult> {
  const row = await registryConfigs(deps, orgId).findFirst();
  if (!row?.enabled) return { orgId, moved: [], skipped: 'registry disabled' };
  const manager = deps.hub.managerNode(orgId);
  if (!manager) return { orgId, moved: [], skipped: 'no manager online' };
  const live = liveRegistryServices(deps.hub, orgId);
  const topology = registryTopologyFor(deps.hub, orgId);
  const signature = registryTopologySignature(topology, live);
  if (signature === last) return { orgId, topology, moved: [], skipped: 'unchanged' };
  // Nothing moves until every ready node forwards (and nothing ever moves back).
  if (topology === 'mesh') return { orgId, topology, moved: [], signature };

  const moved: RegistryTopologyResult['moved'] = [];
  const skip = (skipped: string): RegistryTopologyResult => ({ orgId, topology, moved, skipped });
  if (live.registry && liveRegistryTopology(live.registry) !== 'loopback') {
    if (registryIsReadOnly(live.registry)) return skip('a GC window holds the registry read-only');
    const t = locateRegistry(deps.hub, orgId);
    if (typeof t === 'string') return skip(t);
    const spec = registryMaintenanceSpec(t.live, t.swarmNodeId, false, 'loopback');
    if (!spec) return skip('the registry has no login yet (the auth converge runs first)');
    await deps.hub.dispatch(manager, 'service.deploy', { spec, pullPolicy: 'missing' });
    moved.push('registry');
  }
  if (live.cache && liveRegistryTopology(live.cache) !== 'loopback') {
    if ((await ensureCache(deps, orgId, manager, cacheHubAuthOf(row))) === 'deployed') moved.push('cache');
  }
  if (moved.length) {
    await writeAudit(systemContext(deps, orgId), {
      action: 'cicd.registry.topology',
      targetType: 'registryConfig',
      targetId: orgId,
      actorType: 'system',
      metadata: { topology, moved },
    });
  }
  return { orgId, topology, moved, signature };
}

/**
 * Every org with an enabled registry; one org's failure never stops the rest.
 * The worker owns `state` (org → last signature); `force` ignores it (the
 * periodic re-check for a move Docker never applied).
 */
export async function convergeRegistryTopologyAllOrgs(
  deps: Deps,
  state: Map<string, string>,
  opts: { force?: boolean } = {},
): Promise<RegistryTopologyResult[]> {
  const orgs = await allOrgRows(deps, registryConfigs, { where: { enabled: true } }).catch(() => []);
  const out: RegistryTopologyResult[] = [];
  for (const { orgId } of orgs) {
    const r = await convergeRegistryTopologyForOrg(deps, orgId, opts.force ? undefined : state.get(orgId)).catch(
      (e): RegistryTopologyResult => ({ orgId, moved: [], skipped: 'failed', error: e instanceof Error ? e.message : String(e) }),
    );
    if (r.signature) state.set(orgId, r.signature);
    out.push(r);
  }
  return out;
}
