/**
 * The org's ingress settings in ONE write: driver, enabled, topology, image,
 * target nodes, TLS, tunnel, DNS provider, country database and the
 * automatic-address base. The whole patch is validated first (every refused
 * field is named, not just the first), persisted where each per-field setter
 * always wrote it, and the edge converges exactly ONCE — one deploy at most,
 * one apply — instead of once per field. The `ingress.*` setters (ingress-setters.ts) and REST
 * `PUT /ingress/settings` are thin wrappers over it. Guards are the callers'
 * (admin); the last-edge rule and the object-storage rule for edge-per-node
 * live in the topology preflight.
 */
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { byoDnsSettingsFor, ensureByoDnsSecret } from './acme-dns.service';
import { ingressConfigRepo, ingressSettingsOf } from './ingress-config.repo';
import { convergeEdge, readSettings, reapply, tunnelIdFromToken, type IngressSettings, type Topology } from './ingress.service';
import { preflightTopology, swapTopology, swarmyRunsCaddy } from './ingress-topology';
import { currentFacts, ingressSettingsView, mergeIngressPatch, type IngressDoc, type SealedIngressInputs } from './ingress-settings-merge';
import { ingressAudit } from './ingress-settings-audit';
import { ingressRuleIssues, invalidIngressSettings, parseIngressFields } from './ingress-settings.checks';
import {
  DEPLOY_FIELDS,
  patchFields,
  RENDER_FREE_FIELDS,
  type IngressSettingsPatch,
  type IngressSettingsView,
} from './ingress-settings.schema';

async function loadDoc(ctx: OrgContext): Promise<{ doc: IngressDoc; updatedAt: Date }> {
  const row = await ingressConfigRepo.get(ctx, ctx.activeOrgId);
  return { doc: { driver: row.driver, enabled: row.enabled, settings: ingressSettingsOf(row) }, updatedAt: row.updatedAt };
}

/** The full readable view (secrets as set / not set). A read: never dispatches. */
export async function getIngressSettings(ctx: OrgContext): Promise<IngressSettingsView> {
  const { doc, updatedAt } = await loadDoc(ctx);
  return ingressSettingsView(ctx.activeOrgId, doc, updatedAt);
}

/**
 * Apply a patch. Throws BAD_REQUEST (every refused field in `fieldErrors`) /
 * PRECONDITION_FAILED before anything is written; a failed topology deploy throws after restoring the old edge and
 * saves nothing but the cert-store coordinates. Any other converge failure
 * is recorded on `runtime` (as the setters always did), never thrown.
 */
export async function applyIngressSettings(ctx: OrgContext, input: unknown): Promise<void> {
  const { patch: parsed, issues } = parseIngressFields(input);
  const { doc: current } = await loadDoc(ctx);
  const previousTopology: Topology = (current.settings as IngressSettings).topology ?? 'controller';
  // An unchanged topology is no change at all: never remove + recreate the edge for it.
  const patch: IngressSettingsPatch =
    parsed.topology === previousTopology ? { ...parsed, topology: undefined } : parsed;

  // 1. Validate everything (pure): every field's reason, then seal the secrets once.
  const tunnelId = patch.tunnel?.runToken ? tunnelIdFromToken(patch.tunnel.runToken) : null;
  const rules = ingressRuleIssues(patch, currentFacts(current), tunnelId);
  if (issues.length > 0 || rules.length > 0) throw invalidIngressSettings(issues, rules);
  const fields = patchFields(patch);
  if (fields.length === 0) return;
  const sealed: SealedIngressInputs = {
    ...(patch.tunnel?.runToken ? { runTokenEnc: encryptSecret(patch.tunnel.runToken), tunnelId } : {}),
    ...(patch.dnsProvider ? { byo: byoDnsSettingsFor(patch.dnsProvider) } : {}),
  };
  const candidate = mergeIngressPatch(current, patch, sealed);
  const swap = patch.topology !== undefined && swarmyRunsCaddy(candidate);
  // The topology preflight (last-edge rule, object storage, config validates) — nothing deployed yet.
  const deploySettings = swap ? await preflightTopology(ctx, patch.topology!, candidate) : null;

  // 2. Side effects: the DNS token's Docker secret, then the edge (topology swap only).
  if (patch.dnsProvider && sealed.byo) await ensureByoDnsSecret(ctx, patch.dnsProvider.apiToken, sealed.byo.secretName);
  if (swap && deploySettings) {
    await swapTopology(
      ctx,
      { topology: patch.topology!, settings: deploySettings },
      // Restore on failure only an edge swarmy was running before this write.
      swarmyRunsCaddy(current) ? { topology: previousTopology, settings: readSettings(current) } : null,
    );
  }

  // 3. Persist — re-folded onto the latest doc (the preflight may have saved cert-store coordinates).
  await ingressConfigRepo.update(ctx, ctx.activeOrgId, (cur) => {
    const next = mergeIngressPatch(
      { driver: cur.driver, enabled: cur.enabled, settings: ingressSettingsOf(cur) },
      patch,
      sealed,
    );
    return patch.topology ? { ...next, settings: { ...next.settings, topology: patch.topology } } : next;
  });

  // 4. Converge once: the swap WAS the deploy; otherwise deploy only when the
  //    service itself changes, then one apply (a failed deploy is recorded and
  //    there is nothing to apply to; a patch the render never reads skips it).
  const deploys = !swap && DEPLOY_FIELDS.some((f) => patch[f] !== undefined);
  const failed = deploys && (await convergeEdge(ctx)) !== null;
  const renders = swap || fields.some((f) => !RENDER_FREE_FIELDS.includes(f));
  if (!failed && renders) await reapply(ctx, { converged: swap || deploys });

  const { action, metadata } = ingressAudit(patch, {
    previousTopology,
    tunnelId: tunnelId ?? (current.settings as IngressSettings).tunnel?.tunnelId ?? null,
    byoSecretName: sealed.byo?.secretName,
  });
  await writeAudit(ctx, { action, targetType: 'ingressConfig', targetId: ctx.activeOrgId, metadata });
}

/** Apply a patch and read the settings back. */
export async function updateIngressSettings(ctx: OrgContext, patch: unknown): Promise<IngressSettingsView> {
  await applyIngressSettings(ctx, patch);
  return getIngressSettings(ctx);
}
