import type { DbBackupSnapshotView, IncidentView, ReleaseView } from '@swarmy/core';

/** Shared week for the Time travel tests: storefront's deploys, saves and one incident. */
export const NOW = Date.parse('2026-10-23T10:42:00Z');
export const H = 60 * 60 * 1000;
export const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const rel = (id: string, msAgo: number, tags: Record<string, string>, extra: Partial<ReleaseView> = {}): ReleaseView => ({
  id,
  stackName: 'storefront',
  status: 'healthy',
  images: Object.entries(tags).map(([name, tag]) => ({ name, image: `ghcr.io/northwind/storefront-${name}:${tag}` })),
  actor: 'calum@gomacrae.com',
  strategy: null,
  healthGate: null,
  notes: null,
  createdAt: ago(msAgo),
  ...extra,
});

// Newest first, as releases.list returns them.
export const RELEASES: ReleaseView[] = [
  rel('r6', 20 * 60_000, { web: '1.9.0', api: '1.9.0', worker: '1.9.0' }, { status: 'deploying' }),
  rel('r5', 26 * H, { web: '1.8.2', api: '1.8.1', worker: '1.8.1' }, { notes: 'Automatic rollback to release r3' }),
  rel('r4', 26 * H + 20 * 60_000, { web: '1.8.3', api: '1.8.3', worker: '1.8.3' }, { status: 'rolled-back' }),
  rel('r3', 4 * 24 * H, { web: '1.8.2', api: '1.8.1', worker: '1.8.1' }, { status: 'superseded' }),
  rel('r0', 9 * 24 * H, { web: '1.7.0', api: '1.7.0', cdn: '0.9.0' }, { status: 'superseded' }),
];

export const save = (id: string, msAgo: number, engine: DbBackupSnapshotView['engine'] = 'pg_dump'): DbBackupSnapshotView => ({
  id,
  time: ago(msAgo),
  engine,
  sizeBytes: '268435456',
  tags: ['db:storefront/checkout'],
  reason: null,
});
export const SAVES = [save('s33', 33 * H), save('s57', 57 * H), save('s81', 81 * H)];

export const INCIDENT: IncidentView = {
  id: 'inc-1',
  title: 'Failed deploy on storefront',
  status: 'resolved',
  severity: 'major',
  summary: null,
  openedAt: ago(26 * H + 17 * 60_000),
  resolvedAt: ago(26 * H),
  durationSec: 1020,
  eventCount: 3,
  lastEventAt: null,
};
