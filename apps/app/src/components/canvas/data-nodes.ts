import type { CacheClusterView, InvServiceStatus, SearchInstanceView, VectorInstanceView } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { plural, stackTone } from '@/components/apps/app-words';
import { attachEnvLines } from '@/components/buckets/attach-plan';
import { groupResources, shortOf, type ManagedGroup } from '@/components/connections/connections-model';
import type { ResourceKind, StackEndpoints } from '@/components/connections/types';
import { bytes } from '@/lib/format';
import { STATUS_TONE } from './stack-aggregates';

/** One variable attaching adds, as the preview shows it (`+ KEY=value  # note`). */
export interface EnvLine {
  key: string;
  value: string;
  note?: string;
}

/** A managed data store on the app canvas: one node per database, cache, search, vector store or bucket. */
export interface DataNodeSpec {
  id: string;
  kind: ResourceKind;
  name: string;
  /** Plain words: "cache · 512 MB", "bucket · 18.4 GB". */
  sub: string;
  /** The engine, for Controls: "valkey", "meilisearch". */
  tech: string;
  /** One live number ("hit 97%"), null when nothing has been measured. */
  metric: string | null;
  /** Health of the store's main service; null when unknown (a bucket). */
  tone: Tone | null;
  /** Short names of this app's services wired to it. */
  attached: string[];
  /** What attaching adds to a service. */
  env: EnvLine[];
  /** Garage bucket id (the attach input). */
  bucketId?: string;
}

export interface DataLists {
  db?: ReadonlyArray<{ name: string; primary: { status: string }; replicas: { running: number } }>;
  cache?: readonly CacheClusterView[];
  search?: readonly SearchInstanceView[];
  vector?: readonly VectorInstanceView[];
  buckets?: { endpoint: string | null; region: string; buckets: ReadonlyArray<{ id: string; name: string; usageBytes: number; objects: number }> };
}

const SECRET_NOTE = 'a Docker secret, never plain text';

function tone(status: string | undefined): Tone | null {
  if (!status) return null;
  if (status === 'absent') return 'bad';
  const token = STATUS_TONE[status as InvServiceStatus];
  return token ? stackTone(token) : null;
}

function compact(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function secretFile(secret: string | undefined): string {
  return secret ? `/run/secrets/${secret}` : '/run/secrets/…';
}

function postgres(g: ManagedGroup, l: DataLists): Partial<DataNodeSpec> {
  const v = l.db?.find((c) => c.name === g.name);
  const ro = g.others.find((m) => m.role === 'replica')?.host ?? g.main.host;
  const url = (host: string): string => `postgres://postgres:••••@${host}:${g.main.port}/…`;
  return {
    sub: 'database',
    tech: 'postgres',
    metric: v ? (v.replicas.running > 0 ? plural(v.replicas.running, 'standby copy', 'standby copies') : 'no standby copy') : null,
    tone: tone(v?.primary.status),
    env: [
      { key: 'DATABASE_URL', value: url(g.main.host), note: SECRET_NOTE },
      { key: 'DATABASE_RO_URL', value: url(ro), note: ro === g.main.host ? 'no standby yet: the writer' : 'reads from the standby copy' },
    ],
  };
}

function cache(g: ManagedGroup, l: DataLists): Partial<DataNodeSpec> {
  const v = l.cache?.find((c) => c.name === g.name);
  return {
    sub: v ? `cache · ${v.memoryMb} MB` : 'cache',
    tech: v?.engine ?? 'redis protocol',
    metric: v?.stats?.hitRatePct != null ? `hit ${Math.round(v.stats.hitRatePct)}%` : null,
    tone: tone(v?.primary.status),
    env: [
      { key: 'REDIS_URL', value: `redis://${v?.host ?? g.main.host}:${v?.port ?? g.main.port}` },
      { key: 'REDIS_PASSWORD_FILE', value: secretFile(v?.passwordSecret), note: SECRET_NOTE },
    ],
  };
}

function search(g: ManagedGroup, l: DataLists): Partial<DataNodeSpec> {
  const v = l.search?.find((c) => c.name === g.name);
  const engine = v?.engine ?? (g.main.port === 8108 ? 'typesense' : 'meilisearch');
  const host = v?.host ?? g.main.host;
  const key = secretFile(v?.keySecret);
  const env: EnvLine[] =
    engine === 'meilisearch'
      ? [{ key: 'MEILI_HOST', value: v?.url ?? `http://${host}:${g.main.port}` }, { key: 'MEILI_MASTER_KEY_FILE', value: key, note: SECRET_NOTE }]
      : [
          { key: 'TYPESENSE_HOST', value: host },
          { key: 'TYPESENSE_PORT', value: String(g.main.port) },
          { key: 'TYPESENSE_PROTOCOL', value: 'http' },
          { key: 'TYPESENSE_API_KEY_FILE', value: key, note: SECRET_NOTE },
        ];
  return { sub: 'search', tech: engine, metric: v?.stats ? `${compact(v.stats.docs)} docs` : null, tone: tone(v?.status), env };
}

function vector(g: ManagedGroup, l: DataLists): Partial<DataNodeSpec> {
  const v = l.vector?.find((c) => c.name === g.name);
  return {
    sub: 'vector store',
    tech: 'qdrant',
    metric: v?.stats ? plural(v.stats.collections, 'collection') : null,
    tone: tone(v?.status),
    env: [
      { key: 'QDRANT_URL', value: v?.url ?? `http://${g.main.host}:${g.main.port}` },
      { key: 'QDRANT_API_KEY_FILE', value: secretFile(v?.keySecret), note: SECRET_NOTE },
    ],
  };
}

function bucket(g: ManagedGroup, l: DataLists): Partial<DataNodeSpec> {
  const b = l.buckets?.buckets.find((x) => x.name === g.name);
  return {
    sub: b ? `bucket · ${bytes(b.usageBytes)}` : 'bucket',
    tech: 'garage · S3',
    metric: b ? `${compact(b.objects)} files` : null,
    tone: null,
    env: attachEnvLines({ endpoint: l.buckets?.endpoint ?? null, region: l.buckets?.region ?? 'garage', bucket: g.name }),
    ...(b ? { bucketId: b.id } : {}),
  };
}

const BY_KIND = { postgres, cache, search, vector, 'object-storage': bucket } as const;

/** One node per managed store the app has (`stacks.endpoints`), filled in from each store's own list. */
export function dataNodes(e: StackEndpoints, lists: DataLists): DataNodeSpec[] {
  return groupResources(e.resources).map((g) => ({
    id: `data:${g.kind}:${g.name}`,
    kind: g.kind,
    name: g.name,
    sub: g.kind,
    tech: g.kind,
    metric: null,
    tone: null,
    env: [],
    ...BY_KIND[g.kind](g, lists),
    attached: g.attached.map((s) => shortOf(e.stack, s)),
  }));
}

/** A bucket the app doesn't use yet, as a connect target (no node on the canvas). */
export function bucketTarget(b: { id: string; name: string }, lists: DataLists): DataNodeSpec {
  const g = { kind: 'object-storage', name: b.name, main: { kind: 'object-storage', name: b.name, host: 'swarmy-garage', port: 3900, attached: [] }, others: [], attached: [] } as ManagedGroup;
  return { id: `data:object-storage:${b.name}`, kind: 'object-storage', name: b.name, sub: 'bucket', tech: 'garage · S3', metric: null, tone: null, env: [], attached: [], ...bucket(g, lists) };
}
