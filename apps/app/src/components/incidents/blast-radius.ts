import { SYSTEM_STACK, UNGROUPED, type InvEdge, type InvService, type TrafficAppView } from '@swarmy/core';

/** Parts that hold data: a database, cache, queue or search image, or a managed-data label. */
const DATA_IMAGE = /\b(postgres|postgis|timescale|mysql|mariadb|mongo|redis|valkey|keydb|clickhouse|elasticsearch|opensearch|meilisearch|typesense|qdrant|nats|rabbitmq|kafka|minio|garage|etcd|cockroach)\b/i;
const DATA_LABEL = /^swarmy\.(db|cache|search|vector|bucket)\./;

export function holdsData(s: Pick<InvService, 'image' | 'labels'>): boolean {
  return DATA_IMAGE.test(s.image) || Object.keys(s.labels).some((k) => DATA_LABEL.test(k));
}

export interface BlastInput {
  app: string;
  /** The named failing part (short name), if any. */
  part: string | null;
  services: InvService[];
  edges: InvEdge[];
  /** traffic.now's row for the app; undefined = no traffic data. */
  traffic: TrafficAppView | undefined;
  durationSec: number;
}

export interface Blast {
  /** The failing parts (short names). */
  failing: string[];
  /** The address visitors use, when the front door knows one. */
  address: string | null;
  /** Other apps that share none of the failing parts. */
  unaffected: string[];
  /** Other apps wired to a failing part. */
  alsoHit: string[];
  /** True only when we can justify it: nothing that holds data is failing. */
  noDataLost: boolean;
  /** Approximate visitors who saw an error (5xx per minute × minutes open); null without traffic data. */
  visitors: number | null;
}

const short = (s: InvService): string => (s.name.startsWith(`${s.stack}_`) ? s.name.slice(s.stack.length + 1) : s.name);
const userApp = (stack: string): boolean => stack !== UNGROUPED && stack !== SYSTEM_STACK;

/** Where it hit, what it didn't, whether data is at risk and roughly how many visitors saw it. */
export function blastRadius(input: BlastInput): Blast {
  const own = input.services.filter((s) => s.stack === input.app);
  const failingSvcs = own.filter(
    (s) => (input.part !== null && short(s) === input.part) || s.status === 'degraded' || s.status === 'failing',
  );
  const failingIds = new Set(failingSvcs.map((s) => s.id));
  const byId = new Map(input.services.map((s) => [s.id, s]));
  const hit = new Set<string>();
  for (const e of input.edges) {
    const other = failingIds.has(e.from) ? byId.get(e.to) : failingIds.has(e.to) ? byId.get(e.from) : undefined;
    if (other && other.stack !== input.app && userApp(other.stack)) hit.add(other.stack);
  }
  const apps = [...new Set(input.services.map((s) => s.stack))].filter((a) => userApp(a) && a !== input.app).sort();
  const hosts = input.traffic?.hosts ?? [];
  const address = [...hosts].filter((h) => /[a-z]/i.test(h) && !/\.invalid$/.test(h)).sort((a, b) => a.length - b.length || a.localeCompare(b))[0] ?? null;
  const perMin = input.traffic?.errors5xxPerMin ?? null;
  const visitors = perMin !== null ? Math.round(perMin * (input.durationSec / 60)) : null;
  return {
    failing: failingSvcs.map(short),
    address,
    unaffected: apps.filter((a) => !hit.has(a)),
    alsoHit: apps.filter((a) => hit.has(a)),
    noDataLost: failingSvcs.length > 0 && !failingSvcs.some(holdsData),
    visitors: visitors !== null && visitors >= 1 ? visitors : null,
  };
}

/** "data and platform" / "a, b and c". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
