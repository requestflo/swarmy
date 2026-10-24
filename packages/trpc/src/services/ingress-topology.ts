/**
 * Switch the edge topology (geo-edge). 'edge-per-node' runs a GLOBAL
 * host-mode Caddy on every ingress-labelled node; 'controller' runs the
 * classic single replicated service.
 *
 * Swarm can't flip a service between replicated and global in place, so a
 * swap REMOVES the live service and creates the new one (named cert/config
 * volumes are kept — no re-issuance on nodes that already hold certs). There
 * is a brief gap on 80/443 while the new tasks start — which is why an
 * unchanged topology is never swapped (`updateIngressSettings` drops it).
 *
 * Ordering is what keeps settings honest:
 *   1. preflight (edge-per-node has at least one ingress-labelled node to land
 *      on AND swarmy object storage is on; the shared cert store — bucket
 *      `swarmy-edge-certs`, a scoped key, its Docker secret — is ensured; the
 *      driver config validates under the new topology) — no service touched yet;
 *   2. deploy; on failure, best-effort restore the previous topology and throw
 *      — the persisted setting is NOT changed;
 *   3. only then does the caller persist `topology`, and re-apply routes.
 * The ingress-reconcile worker also converges a live mode that disagrees with
 * the persisted setting (see `reconcileIngressOrg`).
 */
import { TRPCError } from '@trpc/server';
import { defaultRegistry, IngressConfigSchema } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { anyIngressLabelledNode } from './ingress-controller';
import { ensureEdgeCertStorage } from './ingress-certs';
import {
  deployTopology,
  driverLower,
  errMessage,
  liveEdgeMode,
  loadOrgConfig,
  modeForTopology,
  patchSettings,
  recordApply,
  type IngressSettings,
  type Topology,
} from './ingress.service';
import type { IngressDoc } from './ingress-settings-merge';

/**
 * swarmy runs a Caddy service only when the edge is Caddy + enabled and the
 * operator hasn't opted into a self-run host Caddy (`applyVia: 'file'`).
 */
export function swarmyRunsCaddy(doc: IngressDoc): boolean {
  const s = doc.settings as IngressSettings;
  const extra = (s.globalOptions?.extraConfig ?? {}) as Record<string, unknown>;
  return driverLower(doc.driver) === 'caddy' && doc.enabled && extra.applyVia !== 'file';
}

/**
 * Step 1, under the candidate doc (the patch folded in, not yet saved).
 * Returns the settings to deploy with (cert store coordinates ensured).
 */
export async function preflightTopology(ctx: OrgContext, topology: Topology, doc: IngressDoc): Promise<IngressSettings> {
  const settings = doc.settings as IngressSettings;
  if (topology === 'edge-per-node' && !anyIngressLabelledNode(ctx)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'No node is marked as an ingress node — edge-per-node runs one Caddy per ingress node, ' +
        'so it would schedule nowhere. Mark at least one node as ingress first.',
    });
  }
  // Edge-per-node shares ONE certificate store in swarmy object storage —
  // without it each edge issues alone and geo-DNS breaks ACME validation.
  // Refuses (PRECONDITION_FAILED) while object storage is off; otherwise the
  // bucket + scoped key + Docker secret are ensured (idempotent). Persisted
  // right away (coordinates only) so a failed deploy never re-mints a key.
  let next: IngressSettings = settings;
  if (topology === 'edge-per-node') {
    const certs = await ensureEdgeCertStorage(ctx, settings.certStorage);
    next = { ...settings, certStorage: certs.settings };
    if (certs.created) await patchSettings(ctx, (prev) => ({ ...prev, certStorage: certs.settings }));
  }
  const target = IngressConfigSchema.parse(
    await loadOrgConfig(ctx, { topology, certStorage: next.certStorage, row: { ...doc, settings: next } }),
  );
  const validation = defaultRegistry.get(target.driver).validate(target);
  if (!validation.ok) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Cannot switch to ${topology}: ${validation.errors.map((e) => e.message).join('; ')}`,
    });
  }
  return next;
}

/**
 * Step 2: deploy `to`. On failure the previous edge (`from`, null when swarmy
 * ran none) is put back with the settings it ran with — the swap may already
 * have removed the old service — and the error is rethrown.
 */
export async function swapTopology(
  ctx: OrgContext,
  to: { topology: Topology; settings: IngressSettings },
  from: { topology: Topology; settings: IngressSettings } | null,
): Promise<void> {
  try {
    await deployTopology(ctx, to.topology, to.settings);
  } catch (e) {
    recordApply(ctx.activeOrgId, false, `topology switch to ${to.topology} failed: ${errMessage(e)}`);
    if (from && liveEdgeMode(ctx) !== modeForTopology(from.topology)) {
      await deployTopology(ctx, from.topology, from.settings).catch(() => undefined);
    }
    throw e;
  }
}
