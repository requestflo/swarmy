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
