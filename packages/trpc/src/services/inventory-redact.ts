import type { Inventory } from '@swarmy/core';
import type { OrgContext } from '../context';
import { buildPrincipal, decide, loadGrants, loadPolicyEngine } from '../abac';
import { redactEnvEntry } from './secret-redact';

/**
 * `inventory.get` for a caller without `secrets.read` on a service: that
 * service's secret-looking env values are masked, exactly as `services.get`
 * masks them (security review M3). Decided per service on its live labels and
 * grants, with one principal, one policy set and one grant query for the
 * whole inventory. Link inference ran before this, on the real values.
 */
export async function redactInventoryFor(ctx: OrgContext, inv: Inventory): Promise<Inventory> {
  if (inv.services.length === 0) return inv;
  const orgId = ctx.activeOrgId;
  const [principal, engine, grants] = await Promise.all([
    buildPrincipal(ctx),
    loadPolicyEngine(ctx.db, orgId),
    loadGrants(ctx.db, orgId, { type: 'service' }),
  ]);
  const services = await Promise.all(
    inv.services.map(async (s) => {
      const r = await decide({
        db: ctx.db,
        orgId,
        principal,
        engine,
        grants,
        action: 'secrets.read',
        resource: { type: 'service', id: s.id, orgId, labels: s.labels },
      });
      return r.decision === 'permit' ? s : { ...s, env: s.env.map(redactEnvEntry) };
    }),
  );
  return { ...inv, services };
}
