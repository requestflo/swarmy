/**
 * IngressConfig repository — swarm-kv `ingress/<orgId>` (P4 slice 1).
 *
 * The org's edge driver + settings: desired config a reconciler converges, so
 * it lives in the swarm's raft store, not the controller DB. Probe results
 * (`settings.domainChecks` observations) stay in memory — see
 * domain-checks.store.ts; only the onboarding gate is persisted here.
 */
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { orgSingleton, reachableOrgIds } from './kv-repo';

/** Mirrors the (removed) Prisma `IngressDriver` enum. */
export type IngressDriverEnum = 'CADDY' | 'TRAEFIK' | 'NONE' | 'CLOUDFLARE_TUNNEL' | 'NGINX' | 'HAPROXY';

export interface IngressConfigDoc {
  driver: IngressDriverEnum;
  enabled: boolean;
  settings: Record<string, unknown>;
}

/**
 * New orgs start with swarmy's own Caddy edge ON (owner decision 2026-09-24),
 * so a deployed app is browser-reachable with zero setup.
 */
export const ingressConfigRepo = orgSingleton<IngressConfigDoc>('ingress', () => ({
  driver: 'CADDY',
  enabled: true,
  settings: {},
}));

/** The settings object of a row (never null/array). */
export function ingressSettingsOf(row: { settings: unknown } | null | undefined): Record<string, unknown> {
  const s = row?.settings;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/** Orgs whose edge is enabled (stored or default) and whose swarm is reachable now. */
export async function ingressEnabledOrgIds(scope: { db: DB; hub: AgentHub }): Promise<string[]> {
  const out: string[] = [];
  for (const orgId of await reachableOrgIds(scope)) {
    const row = await ingressConfigRepo.get(scope, orgId).catch(() => null);
    if (row?.enabled) out.push(orgId);
  }
  return out;
}
