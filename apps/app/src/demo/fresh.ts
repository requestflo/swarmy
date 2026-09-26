import type { DemoStore } from './types';

/**
 * `?fresh=1`: the demo as it looks right after install — one online server,
 * no apps, no services — so the first-run Overview (Welcome) can be seen.
 * Sticky for the session (sessionStorage) so navigating keeps it; `?fresh=0`
 * or {@link leaveFreshDemo} goes back to the full demo.
 */
const KEY = 'swarmy-demo-fresh';

function readFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const p = new URLSearchParams(window.location.search).get('fresh');
    if (p === '1') window.sessionStorage.setItem(KEY, '1');
    if (p === '0') window.sessionStorage.removeItem(KEY);
    return window.sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

// Read once at load: the store is built once, and the router may tidy the URL.
const FRESH = readFlag();

export function isFreshDemo(): boolean {
  return FRESH;
}

/** Full reload onto the first-run screen (the store is built once per load). */
export function enterFreshDemo(): void {
  window.location.assign('/overview?fresh=1');
}

/** Clear the flag and reload onto the full demo. */
export function leaveFreshDemo(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  window.location.assign('/overview?fresh=0');
}

/** The first manager only, joined a few minutes ago; no apps anywhere. */
export function freshWorld(s: DemoStore): void {
  const first = s.nodes.find((n) => n.role === 'manager') ?? s.nodes[0];
  s.nodes = first ? [{ ...first, joinedAt: new Date(Date.now() - 4 * 60_000).toISOString() }] : [];
  s.services = [];
  s.stacks = [];
}

type Bag = Record<string, unknown>;

/** Patch one resolver module's seeded state, if it exists, so it agrees there are no apps. */
function empty(s: DemoStore, key: string, patch: Bag): void {
  const st = s.extra[key] as Bag | undefined;
  if (st && typeof st === 'object') Object.assign(st, patch);
}

/**
 * After the seeds ran: drop everything that belongs to an app (addresses,
 * databases, caches, buckets, releases, incidents, firing alerts, jobs…).
 * Estate-wide setup stays: backup targets, alert channels and rules, the
 * front door, the private network, members.
 */
export function freshenSeeds(s: DemoStore): void {
  empty(s, 'ingress', { domains: [] });
  empty(s, 'alerts', { events: [] });
  empty(s, 'incidents', { incidents: [] });
  empty(s, 'cache', { clusters: [], backups: {} });
  empty(s, 'buckets', { buckets: [] });
  empty(s, 'releases', { releases: [], safety: {} });
  s.extra['releasesCanary'] = [];
  empty(s, 'apps', { apps: [], plans: [] });
  empty(s, 'data', { snapshots: [], restores: [], dbClusters: [], dbSnapshots: [], dbTopologies: [] });
  empty(s, 'searchsvc', { instances: [], backups: {} });
  empty(s, 'vector', { instances: [], pgvector: [] });
  empty(s, 'queues', { queues: [], dlq: {} });
  empty(s, 'jobs', { jobs: [], runs: [] });
}
