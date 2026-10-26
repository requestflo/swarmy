import { describe, expect, it } from 'bun:test';
import { holdMessage, incidentOwner, planTake, TakeIncidentInput } from './incident-owner';

const NOW = new Date('2026-10-25T14:02:00.000Z');
const at = (min: number): Date => new Date(NOW.getTime() + min * 60_000);
const held = (userId: string, untilMin: number) => ({ ownerUserId: userId, ownerName: 'Sam Okafor', ownedUntil: at(untilMin) });

describe('incidentOwner', () => {
  it('names the owner while the hold is live, and whether it is the viewer', () => {
    expect(incidentOwner(held('u-sam', 30), 'u-sam', NOW)).toEqual({ userId: 'u-sam', name: 'Sam Okafor', until: '2026-10-25T14:32:00.000Z', mine: true });
    expect(incidentOwner(held('u-sam', 30), 'u-cal', NOW)?.mine).toBe(false);
    expect(incidentOwner(held('u-sam', 30), null, NOW)?.mine).toBe(false);
  });

  it('lapses on its own: at or past the deadline nobody has it', () => {
    expect(incidentOwner(held('u-sam', 0), 'u-sam', NOW)).toBeNull();
    expect(incidentOwner(held('u-sam', -5), 'u-sam', NOW)).toBeNull();
  });

  it('is nobody when never taken or let go', () => {
    expect(incidentOwner({ ownerUserId: null, ownerName: null, ownedUntil: null }, 'u', NOW)).toBeNull();
    expect(incidentOwner({ ownerUserId: 'u', ownerName: 'x', ownedUntil: null }, 'u', NOW)).toBeNull();
  });

  it('falls back to "Someone" for a hold with no name', () => {
    expect(incidentOwner({ ...held('u', 10), ownerName: '' }, null, NOW)?.name).toBe('Someone');
  });
});

describe('planTake', () => {
  const sam = (untilMin: number) => incidentOwner(held('u-sam', untilMin), 'u-sam', NOW);

  it('a first take holds it 30 minutes', () => {
    expect(planTake(null, 'u-sam', false, NOW)).toEqual({ kind: 'taken', until: at(30) });
  });

  it('the owner taking again keeps it 30 more minutes from the deadline', () => {
    expect(planTake(sam(10), 'u-sam', false, NOW)).toEqual({ kind: 'kept', until: at(40) });
  });

  it('keeping never holds it more than two hours ahead', () => {
    expect(planTake(sam(110), 'u-sam', false, NOW)).toEqual({ kind: 'kept', until: at(120) });
  });

  it('someone else holding it refuses, unless taking it over', () => {
    expect(planTake(sam(10), 'u-cal', false, NOW)).toBeNull();
    expect(planTake(sam(10), 'u-cal', true, NOW)).toEqual({ kind: 'taken-over', until: at(30) });
  });
});

describe('holdMessage', () => {
  it('says each change in plain words', () => {
    expect(holdMessage('taken', 'Sam')).toBe('Sam took this incident for 30 minutes.');
    expect(holdMessage('kept', 'Sam')).toBe('Sam kept it 30 more minutes.');
    expect(holdMessage('taken-over', 'Calum', 'Sam')).toBe('Calum took it over from Sam.');
    expect(holdMessage('released', 'Sam')).toBe('Sam let it go.');
  });
});

describe('TakeIncidentInput', () => {
  it('defaults takeOver to false and needs an id', () => {
    expect(TakeIncidentInput.parse({ id: 'inc1' })).toEqual({ id: 'inc1', takeOver: false });
    expect(TakeIncidentInput.safeParse({ id: '' }).success).toBe(false);
  });
});
