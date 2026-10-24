/**
 * Registry-side GC pass (the image-gc worker's 6h tick; `cicd.runGc` on demand):
 *   scan (read-only one-shot on the volume's node: untagged manifests + size)
 *   → plan (`computeGcPlan` + `planRegistryGc`, both pure; LIVE pinned set)
 *   → signature gate (unchanged plan + nothing pending ⇒ no commands)
 *   → delete manifests through the registry API (regctl, registry read-write)
 *   → read-only window: `registry garbage-collect`, then read-write again.
 *
 * Skips the org — never guesses — when the hub can't see the registry task or
 * a manager, or a build is pushing. A digest pinned in prod is never deleted
 * (see `registry-gc.plan.ts`). System-actor audited.
 */
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { imageGcPolicies, registryConfigs } from './apps.repo';
import { allOrgRows } from './backups.repo';
import { writeAudit } from './audit.service';
import { computeGcPlan, DEFAULT_KEEP_LAST, gcModeOf, systemContext } from './cicd.service';
import { loadGcCandidates } from './gc-candidates';
import { liveImages, locateRegistry, pinnedForRegistry } from './registry-gc.live';
import { floatingRepos, planRegistryGc, registryGcSignature } from './registry-gc.plan';
import { parseRegistryOutput, renderRegistryScanScript } from './registry-gc.scripts';
import { registryIsReadOnly } from './registry-gc.spec';
import { deleteManifests, endMaintenance, runOnRegistryNode, sweepRegistry } from './registry-gc.sweep';
import { decodeRegistryCreds } from './registry-auth';
import { recordRegistryUsage } from './registry-usage';
import { canonicalRegistryHost, isOrgRegistryImage } from './registryPolicy.service';

type Deps = { db: DB; hub: AgentHub; auth: Auth };
/** What the worker remembers per org between ticks (in memory). */
export interface RegistryGcState {
  signature: string;
  /** Manifests were deleted but their blobs not swept yet (the window failed / was skipped). */
  pendingSweep: boolean;
}
export interface RegistryGcResult {
  orgId: string;
  dryRun: boolean;
  skipped?: string;
  planned: number;
  deleted: number;
  swept: boolean;
  reclaimedBytes: number | null;
  error?: string;
  /** Store when present (the worker's signature gate). */
  next?: RegistryGcState;
}
export interface RegistryGcOpts {
  dryRun?: boolean;
  state?: RegistryGcState;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

/** A build pushing now (bounded so a crashed build row can't block GC forever). */
const BUILD_IN_FLIGHT_MS = 2 * 3600_000;
const running = new Set<string>();

export async function runRegistryGcForOrg(deps: Deps, orgId: string, opts: RegistryGcOpts = {}): Promise<RegistryGcResult> {
  const base: RegistryGcResult = { orgId, dryRun: opts.dryRun ?? false, planned: 0, deleted: 0, swept: false, reclaimedBytes: null };
  if (running.has(orgId)) return { ...base, skipped: 'already running' };
  running.add(orgId);
  try {
    return await pass(deps, orgId, opts, base);
  } finally {
    running.delete(orgId);
  }
}

async function pass(deps: Deps, orgId: string, opts: RegistryGcOpts, base: RegistryGcResult): Promise<RegistryGcResult> {
  const now = opts.now ?? new Date();
  const reg = await registryConfigs(deps, orgId).findFirst();
  if (!reg?.enabled) return { ...base, skipped: 'registry disabled' };
  const t = locateRegistry(deps.hub, orgId);
  if (typeof t === 'string') return { ...base, skipped: t };
  if (registryIsReadOnly(t.live) && !base.dryRun) {
    await endMaintenance(deps.hub, t); // a window a controller restart interrupted
    return { ...base, skipped: 'restored read-write after an interrupted GC' };
  }

  const scan = parseRegistryOutput((await runOnRegistryNode(deps.hub, t, renderRegistryScanScript(), true)).output);
  if (scan.stats) recordRegistryUsage(orgId, scan.stats, now);

  const host = canonicalRegistryHost(reg.host);
  const policy = await imageGcPolicies(deps, orgId).findFirst();
  const mode = gcModeOf(policy?.mode);
  const candidates = await loadGcCandidates(deps.db, orgId);
  const pinned = pinnedForRegistry(deps.hub, orgId);
  const plan = computeGcPlan({
    mode,
    days: policy?.days ?? null,
    keepLast: policy?.keepLast ?? DEFAULT_KEEP_LAST,
    keepProd: policy?.keepProd ?? true,
    pinnedDigests: pinned,
    candidates,
    now,
  });
  const deletes = planRegistryGc({
    mode,
    plan,
    candidates,
    pinnedDigests: pinned,
    floatingRepos: floatingRepos(liveImages(deps.hub, orgId), (img) => isOrgRegistryImage(img, host)),
    untagged: scan.untagged,
    now,
  });
  const signature = registryGcSignature(deletes);
  const planned = { ...base, planned: deletes.length };
  const pending = opts.state?.pendingSweep ?? false;
  if (base.dryRun) return planned;
  if (opts.state && signature === opts.state.signature && !pending) return { ...planned, skipped: 'unchanged' };
  if (!deletes.length && !pending) return { ...planned, next: { signature, pendingSweep: false } };
  const inFlight = await deps.db.build.count({
    where: { orgId, status: { in: ['QUEUED', 'BUILDING', 'PUSHING'] }, createdAt: { gte: new Date(now.getTime() - BUILD_IN_FLIGHT_MS) } },
  });
  if (inFlight > 0) return { ...planned, skipped: 'a build is pushing' };
  if (!t.live.env.includes('REGISTRY_STORAGE_DELETE_ENABLED=true')) {
    // Deployed before deletes were in the spec: redeploy it with them (pinned), delete next tick.
    await endMaintenance(deps.hub, t);
    return { ...planned, skipped: 'turned on manifest deletes in the registry; deleting next tick' };
  }

  // Re-read the pinned set right before deleting: a deploy may have started since the scan.
  const fresh = pinnedForRegistry(deps.hub, orgId);
  const todo = deletes.filter((d) => !fresh.has(d.digest));
  const deleted = await deleteManifests(deps.hub, t, host, decodeRegistryCreds(reg.credentialsEnc), todo);
  if (!deleted.length && !pending) return { ...planned, next: { signature, pendingSweep: false } };

  const sweep = await sweepRegistry(deps.hub, t, opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))));
  if (sweep.stats) recordRegistryUsage(orgId, sweep.stats, now, { deleted: deleted.length, reclaimedBytes: sweep.reclaimedBytes });
  await writeAudit(systemContext(deps, orgId), {
    action: 'cicd.registry.gc',
    targetType: 'registryConfig',
    targetId: orgId,
    actorType: 'system',
    metadata: { mode, deleted: deleted.length, swept: sweep.ok, reclaimedBytes: sweep.reclaimedBytes, error: sweep.error },
  });
  return {
    ...planned,
    deleted: deleted.length,
    swept: sweep.ok,
    reclaimedBytes: sweep.reclaimedBytes,
    ...(sweep.error ? { error: sweep.error } : {}),
    next: { signature, pendingSweep: !sweep.ok },
  };
}

/** Every org with an enabled registry. The worker owns `state` — its per-org signature gate. */
export async function runRegistryGcAllOrgs(deps: Deps, state: Map<string, RegistryGcState>): Promise<RegistryGcResult[]> {
  const orgs = await allOrgRows(deps, registryConfigs, { where: { enabled: true } }).catch(() => []);
  const out: RegistryGcResult[] = [];
  for (const { orgId } of orgs) {
    const r = await runRegistryGcForOrg(deps, orgId, { state: state.get(orgId) }).catch(
      (e): RegistryGcResult => ({ orgId, dryRun: false, planned: 0, deleted: 0, swept: false, reclaimedBytes: null, skipped: 'failed', error: String(e) }),
    );
    if (r.next) state.set(orgId, r.next);
    out.push(r);
  }
  return out;
}
