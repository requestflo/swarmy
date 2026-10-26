import { displayEmail } from '@swarmy/auth';
import {
  holdMessage,
  incidentOwner,
  planTake,
  type IncidentDetailView,
  type IncidentRefInput,
  type TakeIncidentInput,
  type TakeKind,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { getIncident } from './incidents.service';

/**
 * Incident owner — "Take it for 30 min". The hold is three columns on the
 * incident (who, their name, until when) and lapses on its own: every read
 * judges it against now (`incidentOwner`), so no worker clears it. Each take,
 * keep, take-over and let-go writes one timeline event (the queryable history
 * of who had it) and one audit row. Writes are conditional on the hold the
 * caller saw, so two people taking at once can't both win.
 */

const EVENT_KIND: Record<TakeKind | 'released', string> = {
  taken: 'owner.taken',
  kept: 'owner.kept',
  'taken-over': 'owner.takenOver',
  released: 'owner.released',
};

function whoAmI(ctx: OrgContext): string {
  return ctx.user.name || displayEmail(ctx.user.email) || 'Someone';
}

async function openIncident(ctx: OrgContext, id: string) {
  const row = await ctx.db.incident.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('incident', id);
  if (row.status !== 'OPEN') throw commandRejected('this incident is resolved, so nobody needs to take it');
  return row;
}

/** Take an open incident for 30 minutes, keep it 30 more, or (asked) take it over. */
export async function takeIncident(ctx: OrgContext, input: TakeIncidentInput): Promise<IncidentDetailView> {
  const row = await openIncident(ctx, input.id);
  const now = new Date();
  const current = incidentOwner(row, ctx.user.id, now);
  const plan = planTake(current, ctx.user.id, input.takeOver, now);
  if (!plan) throw commandRejected(`${current!.name} has this incident; take it over to have it yourself`);
  const name = whoAmI(ctx);
  await holdWrite(ctx, row, { ownerUserId: ctx.user.id, ownerName: name, ownedUntil: plan.until });
  const previous = plan.kind === 'taken-over' ? current!.name : null;
  await ctx.db.incidentEvent.create({
    data: {
      orgId: ctx.activeOrgId,
      incidentId: row.id,
      at: now,
      kind: EVENT_KIND[plan.kind],
      message: holdMessage(plan.kind, name, previous),
      meta: { author: name, owner: ctx.user.id, until: plan.until.toISOString(), ...(previous ? { previous } : {}) } as object,
    },
  });
  await writeAudit(ctx, {
    action: plan.kind === 'kept' ? 'incidents.keep' : 'incidents.take',
    targetType: 'incident',
    targetId: row.id,
    metadata: { until: plan.until.toISOString(), ...(previous ? { takenFrom: current!.userId } : {}) },
  });
  return getIncident(ctx, { id: row.id });
}

/** Let go of an incident you have. Only the owner can; anyone else takes it over. */
export async function releaseIncident(ctx: OrgContext, input: IncidentRefInput): Promise<IncidentDetailView> {
  const row = await openIncident(ctx, input.id);
  const now = new Date();
  const current = incidentOwner(row, ctx.user.id, now);
  if (!current) throw commandRejected('nobody has this incident right now');
  if (!current.mine) throw commandRejected(`${current.name} has this incident; only they can let it go`);
  await holdWrite(ctx, row, { ownerUserId: null, ownerName: null, ownedUntil: null });
  const name = whoAmI(ctx);
  await ctx.db.incidentEvent.create({
    data: {
      orgId: ctx.activeOrgId,
      incidentId: row.id,
      at: now,
      kind: EVENT_KIND.released,
      message: holdMessage('released', name),
      meta: { author: name, owner: ctx.user.id } as object,
    },
  });
  await writeAudit(ctx, { action: 'incidents.release', targetType: 'incident', targetId: row.id, metadata: { heldUntil: current.until } });
  return getIncident(ctx, { id: row.id });
}

type Hold = { ownerUserId: string | null; ownerName: string | null; ownedUntil: Date | null };

/** Swap the hold only if it is still the one the caller read. */
async function holdWrite(ctx: OrgContext, row: { id: string } & Hold, next: Hold): Promise<void> {
  const res = await ctx.db.incident.updateMany({
    where: { id: row.id, orgId: ctx.activeOrgId, status: 'OPEN', ownerUserId: row.ownerUserId, ownedUntil: row.ownedUntil },
    data: next,
  });
  if (res.count === 0) throw commandRejected('someone changed who has this incident just now; look again');
}
