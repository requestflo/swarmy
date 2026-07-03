import type {
  IncidentDetailView,
  IncidentEventView,
  IncidentView,
  IncidentsOverview,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Incidents demo resolvers — the Incidents surface (`/incidents`): open/past
 * incidents, timelines and post-mortem notes.
 *
 * Seeded with the canonical failover story (resolved: London node offline at
 * 14:01 → automatic promotion → healthy at 14:05, plus a post-mortem note) and
 * one OPEN deploy-gate incident so both list sections and the live detail
 * actions (note / resolve / reopen) render under `?demo=1`. Shapes mirror
 * `incidents.service.ts` views exactly (imported from @swarmy/core).
 */

interface DemoIncident {
  id: string;
  title: string;
  status: 'open' | 'resolved';
  severity: 'minor' | 'major' | 'critical';
  summary: string | null;
  openedAt: string;
  resolvedAt: string | null;
  events: IncidentEventView[];
}

interface IncidentsState {
  incidents: DemoIncident[];
}

function getState(store: DemoStore): IncidentsState {
  return store.extra.incidents as IncidentsState;
}

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function durationSec(openedAt: string, resolvedAt: string | null): number {
  const end = resolvedAt ? new Date(resolvedAt).getTime() : Date.now();
  return Math.max(0, Math.round((end - new Date(openedAt).getTime()) / 1000));
}

function toView(i: DemoIncident): IncidentView {
  return {
    id: i.id,
    title: i.title,
    status: i.status,
    severity: i.severity,
    summary: i.summary,
    openedAt: i.openedAt,
    resolvedAt: i.resolvedAt,
    durationSec: durationSec(i.openedAt, i.resolvedAt),
    eventCount: i.events.length,
    lastEventAt: i.events.at(-1)?.at ?? null,
  };
}

function toDetail(i: DemoIncident): IncidentDetailView {
  return { ...toView(i), events: [...i.events] };
}

function requireIncident(s: DemoStore, id: string): DemoIncident {
  const found = getState(s).incidents.find((i) => i.id === id);
  if (!found) throw new Error(`incident "${id}" not found`);
  return found;
}

/** Yesterday at a given local wall-clock time — keeps the 14:01 story legible. */
function yesterdayAt(h: number, m: number, s: number): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(h, m, s, 0);
  return d.toISOString();
}

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

export const incidents: DomainResolvers = {
  handlers: {
    'incidents.overview': (_i, s): IncidentsOverview => {
      const all = getState(s).incidents;
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return {
        open: all.filter((i) => i.status === 'open').length,
        openCritical: all.filter((i) => i.status === 'open' && i.severity === 'critical').length,
        resolved7d: all.filter(
          (i) => i.status === 'resolved' && i.resolvedAt && new Date(i.resolvedAt).getTime() >= weekAgo,
        ).length,
        total: all.length,
      };
    },

    'incidents.list': (i, s): IncidentView[] => {
      const input = (i as { status?: 'open' | 'resolved'; limit?: number } | undefined) ?? {};
      return getState(s)
        .incidents.filter((row) => (input.status ? row.status === input.status : true))
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
          return a.openedAt < b.openedAt ? 1 : -1;
        })
        .slice(0, input.limit ?? 50)
        .map(toView);
    },

    'incidents.get': (i, s): IncidentDetailView => {
      const { id } = i as { id: string };
      return toDetail(requireIncident(s, id));
    },

    'incidents.addNote': (i, s): IncidentEventView => {
      const { id, message } = i as { id: string; message: string };
      const incident = requireIncident(s, id);
      const event: IncidentEventView = {
        id: rid('ie'),
        at: new Date().toISOString(),
        kind: 'note',
        message,
        meta: { author: s.user.name },
      };
      incident.events.push(event);
      return event;
    },

    'incidents.resolve': (i, s): IncidentDetailView => {
      const { id, message } = i as { id: string; message?: string };
      const incident = requireIncident(s, id);
      if (incident.status === 'resolved') throw new Error('this incident is already resolved');
      const now = new Date().toISOString();
      incident.status = 'resolved';
      incident.resolvedAt = now;
      incident.events.push({
        id: rid('ie'),
        at: now,
        kind: 'resolved',
        message: message?.trim() || `Manually resolved by ${s.user.name}`,
        meta: { manual: true },
      });
      return toDetail(incident);
    },

    'incidents.reopen': (i, s): IncidentDetailView => {
      const { id } = i as { id: string };
      const incident = requireIncident(s, id);
      if (incident.status === 'open') throw new Error('this incident is already open');
      incident.status = 'open';
      incident.resolvedAt = null;
      incident.events.push({
        id: rid('ie'),
        at: new Date().toISOString(),
        kind: 'reopened',
        message: `Reopened by ${s.user.name}`,
        meta: { manual: true },
      });
      return toDetail(incident);
    },
  },

  seed: (store) => {
    const gkDb = { groupKey: 'db:main-db' };
    const gkRel = { groupKey: 'release:storefront' };

    const failover: DemoIncident = {
      id: 'inc-failover-main-db',
      title: 'Database cluster main-db disruption',
      status: 'resolved',
      severity: 'critical',
      summary:
        'Provider hypervisor maintenance took london-1 down. Automatic failover promoted main-db-1 in 2m 21s — no data loss.',
      openedAt: yesterdayAt(14, 1, 12),
      resolvedAt: yesterdayAt(14, 5, 47),
      events: [
        {
          id: 'ie-f1',
          at: yesterdayAt(14, 1, 12),
          kind: 'opened',
          message: 'Incident opened (db:main-db)',
          meta: gkDb,
        },
        {
          id: 'ie-f2',
          at: yesterdayAt(14, 1, 12),
          kind: 'alert.fired',
          message: 'node-offline on node:london-1 — London node stopped answering health checks',
          meta: { ...gkDb, signal: 'node-offline' },
        },
        {
          id: 'ie-f3',
          at: yesterdayAt(14, 2, 3),
          kind: 'db.degraded',
          message:
            'Primary main-db-0 unreachable from every replica — failover grace window started',
          meta: gkDb,
        },
        {
          id: 'ie-f4',
          at: yesterdayAt(14, 3, 33),
          kind: 'db.failover',
          message: 'Promoted replica main-db-1 (lowest lag, 0.3s) to primary',
          meta: { ...gkDb, from: 'main-db-0', to: 'main-db-1' },
        },
        {
          id: 'ie-f5',
          at: yesterdayAt(14, 3, 36),
          kind: 'db.repoint',
          message: 'Repointed replicas main-db-2 and main-db-3 at the new primary',
          meta: gkDb,
        },
        {
          id: 'ie-f6',
          at: yesterdayAt(14, 5, 47),
          kind: 'alert.resolved',
          message: 'node-offline on node:london-1 recovered — cluster healthy on new leader',
          meta: { ...gkDb, signal: 'node-offline' },
        },
        {
          id: 'ie-f7',
          at: yesterdayAt(16, 20, 5),
          kind: 'note',
          message:
            'Post-mortem: provider confirmed hypervisor maintenance hit london-1. Added a second London node so the region keeps quorum next time.',
          meta: { author: 'Calum Macrae' },
        },
      ],
    };

    const deployGate: DemoIncident = {
      id: 'inc-deploy-storefront',
      title: 'Failed deploy on storefront',
      status: 'open',
      severity: 'critical',
      summary: null,
      openedAt: minutesAgo(18),
      resolvedAt: null,
      events: [
        {
          id: 'ie-d1',
          at: minutesAgo(18),
          kind: 'opened',
          message: 'Incident opened (release:storefront)',
          meta: gkRel,
        },
        {
          id: 'ie-d2',
          at: minutesAgo(18),
          kind: 'deploy.gate.failed',
          message:
            'Release rel-9f31d2 failed its health gate (storefront: 2/5 tasks unhealthy; error-rate 12%)',
          meta: { ...gkRel, releaseId: 'rel-9f31d2', stackName: 'storefront' },
        },
        {
          id: 'ie-d3',
          at: minutesAgo(16),
          kind: 'deploy.gate.rollback',
          message: 'Auto-rolled storefront back to release rel-8c02aa',
          meta: { ...gkRel, failedReleaseId: 'rel-9f31d2', rolledBackTo: 'rel-8c02aa' },
        },
        {
          id: 'ie-d4',
          at: minutesAgo(14),
          kind: 'alert.fired',
          message: 'error-rate on service:web — 12% of requests failing (threshold 5%)',
          meta: { ...gkRel, signal: 'error-rate' },
        },
      ],
    };

    store.extra.incidents = { incidents: [failover, deployGate] } satisfies IncidentsState;
  },
};
