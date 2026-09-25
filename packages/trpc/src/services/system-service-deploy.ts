/**
 * Converging swarmy's own system services WITHOUT needless rolling restarts
 * (QA-049).
 *
 * The reconcilers rebuild each system service's spec from scratch every
 * converge (and on every controller boot). Docker's live spec carries
 * CLI-filled defaults (restart delays, isolation, platforms…) that a rebuilt
 * spec never states, so "update with the same spec" was never a no-op: every
 * swarmy-dns converge restarted every nameserver, which took ns1 down (tasks
 * Rejected "context canceled" for about 3 minutes).
 *
 * The fix never compares against Docker's form. It hashes the DESIRED spec,
 * swarmy's own normalised ServiceSpec, stamps the hash as a label, and
 * dispatches only when that hash changes. Unchanged desired spec → nothing
 * dispatched. System services also get a rolling policy that keeps all but
 * one task up.
 */
import { createHash } from 'node:crypto';
import type { ServiceSpec } from '@swarmy/core/protocol';

/** Label carrying the hash of the desired spec a system service was deployed from. */
export const SPEC_SIGNATURE_LABEL = 'swarmy.spec.sig';

/** Stable JSON (sorted keys; `undefined` dropped) — the same spec always hashes the same. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = stable(x);
    }
    return out;
  }
  return v;
}

/** PURE — the signature of a desired spec (its own signature label excluded). */
export function specSignature(spec: ServiceSpec): string {
  const { [SPEC_SIGNATURE_LABEL]: _drop, ...labels } = spec.labels ?? {};
  return createHash('sha256')
    .update(JSON.stringify(stable({ ...spec, labels })))
    .digest('hex')
    .slice(0, 16);
}

/** PURE — the spec with its signature stamped. */
export function withSpecSignature(spec: ServiceSpec): ServiceSpec {
  return { ...spec, labels: { ...(spec.labels ?? {}), [SPEC_SIGNATURE_LABEL]: specSignature(spec) } };
}

/** PURE — does the live service already run this desired spec? */
export function specUnchanged(live: { labels: Record<string, string> } | undefined, spec: ServiceSpec): boolean {
  return !!live && live.labels[SPEC_SIGNATURE_LABEL] === specSignature(spec);
}

/**
 * The rolling policy for system services: one task at a time, a pause and a
 * health watch between tasks, rolled back if the new task fails. With
 * stop-first (host-network services like swarmy-dns and the edge bind their
 * ports, so two tasks can't overlap on one node) at most ONE node's task is
 * ever down during an update.
 */
export const SYSTEM_UPDATE_CONFIG: NonNullable<ServiceSpec['updateConfig']> = {
  parallelism: 1,
  order: 'stop-first',
  failureAction: 'rollback',
  monitorNs: 15_000_000_000,
  delayNs: 10_000_000_000,
};

// ── the central gate (every system-service converge) ─────────────────────────

/** Label prefixes of reconciler-owned managed-data services. */
const MANAGED_DATA_PREFIXES = ['swarmy.db.', 'swarmy.cache.', 'swarmy.search.', 'swarmy.vector.', 'swarmy.storage.'];

/**
 * PURE — is this a service swarmy's own reconcilers converge (and so re-send
 * on every tick and boot)? swarmy's platform services (`swarmy.system`,
 * `swarmy-*` / `swarmy_*` names) and the managed-data services. User app
 * deploys are never gated: an identical redeploy can be a deliberate restart.
 */
export function isSystemOwned(spec: Pick<ServiceSpec, 'name' | 'labels'>): boolean {
  const labels = spec.labels ?? {};
  if (labels['swarmy.system'] === 'true') return true;
  if (/^swarmy[-_]/.test(spec.name)) return true;
  return Object.keys(labels).some((k) => MANAGED_DATA_PREFIXES.some((p) => k.startsWith(p)));
}

/** The signature of a deploy: the desired spec plus the pull credentials it carries. */
export function deploySignature(spec: ServiceSpec, auth?: { username?: string; password?: string; server?: string } | null): string {
  const base = specSignature(spec);
  if (!auth) return base;
  return createHash('sha256')
    .update(`${base}\u0000${auth.server ?? ''}\u0000${auth.username ?? ''}\u0000${auth.password ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

export interface DeployPayloadLike {
  spec: ServiceSpec;
  registryAuth?: { username?: string; password?: string; server?: string } | null;
  pullPolicy?: 'always' | 'missing' | 'never';
}

/**
 * PURE — gate a `service.deploy` of a system-owned service. Returns the
 * payload with its signature stamped, and `skip: true` when the live service
 * already runs exactly this desired spec. Never skips:
 *  - a service that isn't system-owned;
 *  - a spec with no live service yet;
 *  - `pullPolicy: 'always'` on a floating tag (a fresh pull is the point);
 *    a digest-pinned image re-pulls nothing, so that one may still skip.
 */
export function gateSystemDeploy<P extends DeployPayloadLike>(
  payload: P,
  live: { labels: Record<string, string> } | undefined,
): { payload: P; skip: boolean } {
  const spec = payload.spec;
  if (!spec || !isSystemOwned(spec)) return { payload, skip: false };
  const sig = deploySignature(spec, payload.registryAuth);
  const stamped = { ...payload, spec: { ...spec, labels: { ...(spec.labels ?? {}), [SPEC_SIGNATURE_LABEL]: sig } } };
  const freshPull = payload.pullPolicy === 'always' && !spec.image.includes('@sha256:');
  const skip = !freshPull && !!live && live.labels[SPEC_SIGNATURE_LABEL] === sig;
  return { payload: stamped, skip };
}
