/**
 * Adoption keeps an environment's own secrets (@swarmy/app-config
 * own-secrets.ts): a cloned environment filled `<x>.<env>`, and once
 * swarmy.yaml names it, that family — not the shared `<x>` — is what its
 * services keep reading. Which families exist is Docker truth: the org's
 * secret families listed on a manager, or, when no manager answers, the ones
 * the environment's own stack already mounts. Asked only when a named
 * environment reads a secret, so production and previews never pay for it.
 */
import { buildInventory, type InvService } from '@swarmy/core';
import { ownSecretCandidates, withOwnSecrets, type DesiredApp } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import { resolveManagerNode } from '../dispatch.service';
import { groupSecrets, listRawSecrets, parsePhysicalSecretName } from '../secretsMgr.service';

export type ListFamilies = (ctx: OrgContext) => Promise<string[]>;

export const listOrgFamilies: ListFamilies = async (ctx) => {
  const node = await resolveManagerNode(ctx);
  return groupSecrets(await listRawSecrets(ctx, node.id), ctx.activeOrgId).families.map((f) => f.family);
};

/** PURE — the secret families a stack's live services mount (`<family>__v<n>` refs). */
export function mountedFamilies(services: readonly InvService[], stack: string): string[] {
  const out = new Set<string>();
  for (const s of services)
    if (s.stack === stack)
      for (const n of s.secrets ?? []) {
        const family = parsePhysicalSecretName(n)?.family;
        if (family) out.add(family);
      }
  return [...out].sort();
}

/** The desired app with every secret it reads from its environment's own family, where one exists. */
export async function withExistingOwnSecrets(
  ctx: OrgContext,
  desired: DesiredApp,
  list: ListFamilies = listOrgFamilies,
): Promise<DesiredApp> {
  const wanted = new Set(ownSecretCandidates(desired));
  if (!wanted.size) return desired;
  const families = await list(ctx).catch(() => {
    const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
    return mountedFamilies(buildInventory(services, containers).services, desired.stack);
  });
  return withOwnSecrets(desired, new Set(families.filter((f) => wanted.has(f))));
}
