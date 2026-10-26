import { holdMessage, incidentOwner, planTake, type IncidentDetailView, type TakeIncidentInput } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { requireIncident, rid, toDetail, type DemoIncident } from './incidents';

/**
 * "Take it for 30 min" in the demo: `incidents.take` / `incidents.release`
 * over the incidents store, judged by the same pure rules as the controller
 * (`@swarmy/core` incident-owner.ts) and written to the timeline the same way.
 */
const KIND = { taken: 'owner.taken', kept: 'owner.kept', 'taken-over': 'owner.takenOver', released: 'owner.released' } as const;

function openOne(s: DemoStore, id: string): DemoIncident {
  const incident = requireIncident(s, id);
  if (incident.status !== 'open') throw new Error('this incident is resolved, so nobody needs to take it');
  return incident;
}

function note(incident: DemoIncident, kind: keyof typeof KIND, message: string, s: DemoStore): void {
  incident.events.push({ id: rid('ie'), at: new Date().toISOString(), kind: KIND[kind], message, meta: { author: s.user.name, owner: s.user.id } });
}

export const incidentHold: DomainResolvers = {
  handlers: {
    'incidents.take': (i, s): IncidentDetailView => {
      const { id, takeOver } = i as TakeIncidentInput;
      const incident = openOne(s, id);
      const current = incident.hold ? incidentOwner(incident.hold, s.user.id) : null;
      const plan = planTake(current, s.user.id, takeOver === true);
      if (!plan) throw new Error(`${current!.name} has this incident; take it over to have it yourself`);
      incident.hold = { ownerUserId: s.user.id, ownerName: s.user.name, ownedUntil: plan.until };
      note(incident, plan.kind, holdMessage(plan.kind, s.user.name, current?.name), s);
      return toDetail(incident, s);
    },

    'incidents.release': (i, s): IncidentDetailView => {
      const { id } = i as { id: string };
      const incident = openOne(s, id);
      const current = incident.hold ? incidentOwner(incident.hold, s.user.id) : null;
      if (!current) throw new Error('nobody has this incident right now');
      if (!current.mine) throw new Error(`${current.name} has this incident; only they can let it go`);
      incident.hold = undefined;
      note(incident, 'released', holdMessage('released', s.user.name), s);
      return toDetail(incident, s);
    },
  },
};
