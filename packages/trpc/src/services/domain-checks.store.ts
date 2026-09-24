/**
 * Custom-domain check records: the onboarding GATE is persisted, the probe
 * OBSERVATIONS live in memory (epic-docker-native-state P1).
 *
 * WHY here and not a label: a check record is the controller's OBSERVATION of
 * the outside world (what public DNS answers, what certificate the edge
 * serves) plus the onboarding gate — not a declaration of how a service
 * behaves. Writing it onto the user's service label would churn the service
 * spec every check. It is not a mirror of routes either: routes stay on
 * `swarmy.ingress.routes`, and a record whose host is no longer routed is
 * pruned.
 *
 * The split:
 *  - **Persisted** in the org's swarm-kv ingress document,
 *    `settings.domainChecks.hosts[host]`: the
 *    gate itself — `host`, `addedAt`, `gated`, `verifiedAt`,
 *    `verifiedManually`. These change at human speed (a domain is added,
 *    verified once, or skipped by an operator), and losing them would re-gate
 *    a live domain or un-gate an unverified one.
 *  - **In memory** (process-local, per org+host): the probe results — `dns`,
 *    `cert`, `lastCheckedAt`, `nextCheckAt`, `certCheckedAt`. They are
 *    rewritten every check; after a controller restart `nextCheckAt` is
 *    unset, so every host is re-probed on the first tick.
 *
 * A patch writes only when a persisted field actually changes, as one
 * compare-and-swap of the ingress document scoped to `domainChecks`.
 */
import { domainChecksOf, type DomainCheckRecord, type DomainChecks } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { ingressConfigRepo, ingressSettingsOf } from './ingress-config.repo';

/** The raw settings JSON of the org's ingress config ({} when no row). */
export async function readIngressSettingsRaw(ctx: OrgContext): Promise<Record<string, unknown>> {
  return ingressSettingsOf(await ingressConfigRepo.find(ctx, ctx.activeOrgId));
}

export { domainChecksOf };

/** The persisted (gate) fields of a record. */
type GateRecord = Pick<DomainCheckRecord, 'host' | 'addedAt' | 'gated' | 'verifiedAt' | 'verifiedManually'>;
/** The in-memory (probe) fields of a record. */
type ProbeRecord = Pick<DomainCheckRecord, 'dns' | 'cert' | 'lastCheckedAt' | 'nextCheckAt' | 'certCheckedAt'>;

/** Per org → per host probe observations. Never persisted. */
const probes = new Map<string, Map<string, ProbeRecord>>();

function orgProbes(orgId: string): Map<string, ProbeRecord> {
  let m = probes.get(orgId);
  if (!m) probes.set(orgId, (m = new Map()));
  return m;
}

function gateOf(r: DomainCheckRecord): GateRecord {
  return {
    host: r.host,
    addedAt: r.addedAt,
    gated: r.gated,
    ...(r.verifiedAt !== undefined ? { verifiedAt: r.verifiedAt } : {}),
    ...(r.verifiedManually !== undefined ? { verifiedManually: r.verifiedManually } : {}),
  };
}

function probeOf(r: DomainCheckRecord): ProbeRecord {
  const out: ProbeRecord = {};
  if (r.dns !== undefined) out.dns = r.dns;
  if (r.cert !== undefined) out.cert = r.cert;
  if (r.lastCheckedAt !== undefined) out.lastCheckedAt = r.lastCheckedAt;
  if (r.nextCheckAt !== undefined) out.nextCheckAt = r.nextCheckAt;
  if (r.certCheckedAt !== undefined) out.certCheckedAt = r.certCheckedAt;
  return out;
}

/**
 * Merge persisted gate records with this process's probe observations. Pure
 * over `settings`; pass the org's raw ingress settings (or a config row's
 * settings) to get the full view.
 */
export function mergeDomainChecks(orgId: string, settings: Record<string, unknown>): DomainChecks | undefined {
  const persisted = domainChecksOf(settings);
  if (!persisted) return undefined;
  const seen = probes.get(orgId);
  const hosts: Record<string, DomainCheckRecord> = {};
  for (const [host, rec] of Object.entries(persisted.hosts)) {
    // Probe fields in a stored blob (written before the split) are ignored:
    // only this process's observations count.
    hosts[host] = { ...gateOf(rec), ...(seen?.get(host) ?? {}) };
  }
  return { hosts };
}

/** The org's domain checks: persisted gate + in-memory observations. */
export async function readDomainChecks(ctx: OrgContext): Promise<DomainChecks | undefined> {
  return mergeDomainChecks(ctx.activeOrgId, await readIngressSettingsRaw(ctx));
}

export interface DomainChecksPatch {
  upserts?: DomainCheckRecord[];
  remove?: string[];
}

const sameGate = (a: GateRecord | undefined, b: GateRecord): boolean =>
  a !== undefined &&
  a.addedAt === b.addedAt &&
  a.gated === b.gated &&
  a.verifiedAt === b.verifiedAt &&
  a.verifiedManually === b.verifiedManually;

/**
 * Apply per-host upserts/removals: probe fields go to memory, gate fields to
 * `settings.domainChecks` — written only when one of them changed.
 */
export async function patchDomainChecks(ctx: OrgContext, patch: DomainChecksPatch): Promise<void> {
  const upserts = patch.upserts ?? [];
  const remove = patch.remove ?? [];
  if (upserts.length === 0 && remove.length === 0) return;

  const mem = orgProbes(ctx.activeOrgId);
  for (const r of upserts) mem.set(r.host, probeOf(r));
  for (const h of remove) mem.delete(h);

  // One compare-and-swap on the org's ingress document (swarm-kv); a lost race
  // re-runs this merge on the fresh settings.
  await ingressConfigRepo.update(ctx, ctx.activeOrgId, (cur) => {
    const settings = ingressSettingsOf(cur);
    const current = domainChecksOf(settings)?.hosts ?? {};
    const next: Record<string, GateRecord> = {};
    for (const [host, rec] of Object.entries(current)) next[host] = gateOf(rec);
    let changed = false;
    for (const r of upserts) {
      const g = gateOf(r);
      if (!sameGate(next[r.host], g)) {
        next[r.host] = g;
        changed = true;
      }
    }
    for (const h of remove) {
      if (next[h]) {
        delete next[h];
        changed = true;
      }
    }
    // A stored blob that still carries probe fields is rewritten gate-only.
    const hadProbeFields = Object.values(current).some((rec) => Object.keys(probeOf(rec)).length > 0);
    if (!changed && !hadProbeFields) return undefined;
    return { settings: { ...settings, domainChecks: { hosts: next } } };
  });
}
