/**
 * The personal-grant TTL sweeper (plans/epic-self-hosted-mesh-and-fleets.md
 * §3.2, M3 "TTL sweeper"; closes the ROADMAP "Direct-connect TTL" gap).
 *
 * A grant's `expiresAt` already keeps it out of the people plan, so access
 * ends at expiry. This revokes the row itself, through the SAME path as a
 * person pressing Revoke (`revokePersonGrant`: row gone, `mesh.access.revoke`
 * audited, here as the system actor with `reason: 'expired'`), then converges
 * NetBird once so the grant's group, policy and DNS go too.
 *
 * Runs for every org with an expired row, whatever its mesh mode: an org that
 * turned the mesh or people access off still loses its stale grants (the
 * converge is then a no-op). The `mesh-grant-ttl` worker is the scheduler.
 */
import { planGrantSweep } from '@swarmy/mesh';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { reconcilePeopleAccess, revokePersonGrant } from './mesh-people.service';

/** Orgs with at least one expired personal grant (the worker's org source). */
export async function orgsWithExpiredGrants(db: DB, now: Date = new Date()): Promise<string[]> {
  const rows = (await db.meshRoute.findMany({
    where: { kind: 'person', expiresAt: { lte: now } },
    select: { orgId: true },
  })) as { orgId: string }[];
  return [...new Set(rows.map((r) => r.orgId))].sort();
}

export interface GrantSweepResult {
  /** Grant ids revoked this run. */
  revoked: string[];
  /** Grants that vanished between the read and the revoke (someone revoked them first). */
  skipped: string[];
  /** Whether NetBird was converged (only when the org's control plane runs in swarmy). */
  converged: boolean;
}

export interface GrantSweepOptions {
  now?: Date;
  /** Seam for tests; default the people reconcile. Returns whether it touched a managed mesh. */
  converge?: (ctx: OrgContext) => Promise<boolean>;
}

const defaultConverge = async (ctx: OrgContext): Promise<boolean> => (await reconcilePeopleAccess(ctx)).managed;

/** Revoke one org's expired personal grants. `ctx` is a system context (worker). */
export async function sweepExpiredPersonGrants(ctx: OrgContext, opts: GrantSweepOptions = {}): Promise<GrantSweepResult> {
  const now = opts.now ?? new Date();
  const rows = (await ctx.db.meshRoute.findMany({
    where: { orgId: ctx.activeOrgId, kind: 'person', expiresAt: { lte: now } },
    select: { id: true, expiresAt: true },
  })) as { id: string; expiresAt: Date | null }[];
  const { expired } = planGrantSweep(rows, now);
  const revoked: string[] = [];
  const skipped: string[] = [];
  for (const g of expired) {
    try {
      await revokePersonGrant(ctx, g.id, { reason: 'expired', converge: false });
      revoked.push(g.id);
    } catch {
      skipped.push(g.id);
    }
  }
  if (!revoked.length) return { revoked, skipped, converged: false };
  const converged = await (opts.converge ?? defaultConverge)(ctx).catch(() => false);
  return { revoked, skipped, converged };
}
