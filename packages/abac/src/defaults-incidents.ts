import type { DefaultPolicySpec } from './defaults';

/**
 * Incident response (2026-10): anyone on the team may take an open incident
 * for 30 minutes ("Sam has this until 14:32"), keep it longer, take it over or
 * let it go. It changes no infrastructure and every hold is on the incident's
 * timeline and in the audit log, so members may by default. The resource is
 * the incident (type `incident`), so an org can narrow it with a forbid rule.
 */
export const INCIDENT_SPECS: DefaultPolicySpec[] = [
  {
    key: 'member-incident-take',
    name: 'Members can take incidents',
    effect: 'permit',
    priority: 32,
    doc: { roles: ['member'], actions: ['incident.take'] },
  },
];
