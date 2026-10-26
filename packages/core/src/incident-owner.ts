import { z } from 'zod';

/**
 * Incident owner — "Take it for 30 min". A person takes an open incident and
 * is its owner until a deadline; the hold lapses on its own (a read past the
 * deadline is nobody), so a forgotten take never blocks anyone. Pure and
 * browser-safe: the controller and the dashboard judge it the same way.
 */

/** One take (or keep) holds the incident this long. */
export const INCIDENT_TAKE_MINUTES = 30;
/** Keeping it again never holds it more than this far ahead. */
export const INCIDENT_HOLD_MAX_MINUTES = 120;

/** Who has an open incident right now. */
export interface IncidentOwnerView {
  userId: string;
  /** Display name at the time they took it ("Sam Okafor"). */
  name: string;
  /** ISO deadline; past it, nobody has the incident. */
  until: string;
  /** The caller is the owner. */
  mine: boolean;
}

/** The stored hold on an incident row. */
export interface IncidentHoldRow {
  ownerUserId: string | null;
  ownerName: string | null;
  ownedUntil: Date | null;
}

/** The live owner, or null when nobody holds it (never held, let go, or lapsed). */
export function incidentOwner(row: IncidentHoldRow, viewerId: string | null, now = new Date()): IncidentOwnerView | null {
  if (!row.ownerUserId || !row.ownedUntil || row.ownedUntil.getTime() <= now.getTime()) return null;
  return {
    userId: row.ownerUserId,
    name: row.ownerName || 'Someone',
    until: row.ownedUntil.toISOString(),
    mine: viewerId !== null && row.ownerUserId === viewerId,
  };
}

export type TakeKind = 'taken' | 'kept' | 'taken-over';

/**
 * What a take does: the first take holds it {@link INCIDENT_TAKE_MINUTES};
 * the owner taking again keeps it that much longer (capped at
 * {@link INCIDENT_HOLD_MAX_MINUTES} from now); someone else holding it is a
 * take-over, and only when asked for (null otherwise).
 */
export function planTake(
  current: IncidentOwnerView | null,
  userId: string,
  takeOver: boolean,
  now = new Date(),
): { kind: TakeKind; until: Date } | null {
  const step = INCIDENT_TAKE_MINUTES * 60_000;
  if (current && current.userId === userId) {
    const from = Math.max(now.getTime(), Date.parse(current.until));
    return { kind: 'kept', until: new Date(Math.min(from + step, now.getTime() + INCIDENT_HOLD_MAX_MINUTES * 60_000)) };
  }
  if (current && !takeOver) return null;
  return { kind: current ? 'taken-over' : 'taken', until: new Date(now.getTime() + step) };
}

/** The timeline line for a take, a keep, a take-over or a let-go. */
export function holdMessage(kind: TakeKind | 'released', name: string, previous?: string | null): string {
  switch (kind) {
    case 'taken':
      return `${name} took this incident for ${INCIDENT_TAKE_MINUTES} minutes.`;
    case 'kept':
      return `${name} kept it ${INCIDENT_TAKE_MINUTES} more minutes.`;
    case 'taken-over':
      return `${name} took it over from ${previous ?? 'someone'}.`;
    case 'released':
      return `${name} let it go.`;
  }
}

export const TakeIncidentInput = z.object({
  id: z.string().min(1),
  /** Take it from whoever has it now (otherwise refused while they hold it). */
  takeOver: z.boolean().default(false),
});
export type TakeIncidentInput = z.infer<typeof TakeIncidentInput>;
