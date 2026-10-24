/**
 * The wildcard-IP base automatic addresses fall back to when the org has no
 * delegated swarmy-ns zone (plans/self-reliance.md B2a). The org's CLUSTER
 * ZONE wins when one is set (B2b: swarmy-dns synthesises `<a-b-c-d>.<zone>`
 * itself); else the org setting (`autoAddressBase` in the org's ingress
 * settings, swarm-kv); else `SWARMY_AUTO_ADDRESS_BASE` for the whole
 * controller; else sslip.io, the public convenience name. The base must be a
 * wildcard-IP DNS service: `<x>.<a-b-c-d>.<base>` has to resolve to a.b.c.d.
 * Changing it re-hosts existing automatic addresses on the domain-verify
 * worker's next tick.
 */
import { DEFAULT_AUTO_ADDRESS_BASE, normalizeAutoAddressBase } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { badRequest } from '../errors';
import { writeAudit } from './audit.service';
import { clusterZoneName } from './cluster-zone';
import { ingressConfigRepo, ingressSettingsOf } from './ingress-config.repo';

export const AUTO_ADDRESS_BASE_ENV = 'SWARMY_AUTO_ADDRESS_BASE';

/** The org's wildcard base: its cluster zone, its own setting, the controller env; null = sslip.io. Pure. */
export function wildcardBaseFrom(
  settings: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
  clusterZone: string | null = null,
): string | null {
  const own = typeof settings.autoAddressBase === 'string' ? normalizeAutoAddressBase(settings.autoAddressBase) : null;
  return normalizeAutoAddressBase(clusterZone) ?? own ?? normalizeAutoAddressBase(env[AUTO_ADDRESS_BASE_ENV]);
}

export interface AutoAddressBaseView {
  /** The org's own setting (null = not set). */
  base: string | null;
  /** The controller-wide `SWARMY_AUTO_ADDRESS_BASE` (null = not set). */
  envBase: string | null;
  /** The org's cluster zone (wins over both when set; null = none). */
  clusterZone: string | null;
  /** What addresses are formed under right now (without a delegated zone). */
  effective: string;
  defaultBase: string;
}

function view(settings: Record<string, unknown>, clusterZone: string | null): AutoAddressBaseView {
  const base = typeof settings.autoAddressBase === 'string' ? normalizeAutoAddressBase(settings.autoAddressBase) : null;
  const envBase = normalizeAutoAddressBase(process.env[AUTO_ADDRESS_BASE_ENV]);
  const effective = wildcardBaseFrom(settings, process.env, clusterZone) ?? DEFAULT_AUTO_ADDRESS_BASE;
  return { base, envBase, clusterZone, effective, defaultBase: DEFAULT_AUTO_ADDRESS_BASE };
}

export async function getAutoAddressBase(ctx: OrgContext): Promise<AutoAddressBaseView> {
  return view(ingressSettingsOf(await ingressConfigRepo.get(ctx, ctx.activeOrgId)), await clusterZoneName(ctx));
}

/** Set (or clear, `null`) the org's wildcard base. Audited. */
export async function setAutoAddressBase(ctx: OrgContext, raw: string | null): Promise<AutoAddressBaseView> {
  const base = raw === null || raw.trim() === '' ? null : normalizeAutoAddressBase(raw);
  if (raw !== null && raw.trim() !== '' && !base) {
    throw badRequest(`${raw} is not a domain name — use a wildcard-IP DNS service such as sslip.io or nip.io`);
  }
  const row = await ingressConfigRepo.update(ctx, ctx.activeOrgId, (cur) => {
    const { autoAddressBase: _old, ...rest } = ingressSettingsOf(cur);
    return { settings: base ? { ...rest, autoAddressBase: base } : rest };
  });
  await writeAudit(ctx, {
    action: 'ingress.setAutoAddressBase',
    targetType: 'ingressConfig',
    targetId: ctx.activeOrgId,
    metadata: { base: base ?? 'unset' },
  });
  return view(ingressSettingsOf(row), await clusterZoneName(ctx));
}
