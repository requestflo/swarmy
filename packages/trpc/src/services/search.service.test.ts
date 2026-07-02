import { describe, expect, it } from 'bun:test';
import {
  encodeSearchStatsLabel,
  meiliDumpCommand,
  parseMeiliStats,
  parseSearchStats,
  parseSearchStatsLabel,
  parseTypesenseStats,
  searchAttachEnv,
  searchInjectVar,
  searchInstanceSpec,
  searchKeySecretName,
  searchServiceName,
  searchStatsCommand,
  SEARCH_SECRET_TARGET,
} from './search.service';

const MEILI_STATS = JSON.stringify({
  databaseSize: 447819776,
  usedDatabaseSize: 196608,
  lastUpdate: '2026-07-01T11:15:22.092896Z',
  indexes: {
    movies: { numberOfDocuments: 19654, isIndexing: false, fieldDistribution: { title: 19654 } },
    products: { numberOfDocuments: 346, isIndexing: true, fieldDistribution: {} },
  },
});

describe('parseMeiliStats — /stats JSON → sample', () => {
  it('sums documents across indexes and reads databaseSize', () => {
    expect(parseMeiliStats(MEILI_STATS)).toEqual({
      docs: 20000,
      indexes: 2,
      dbSizeBytes: 447819776,
      memoryBytes: null,
    });
  });

  it('handles an empty engine (no indexes yet)', () => {
    expect(parseMeiliStats('{"databaseSize":16384,"indexes":{}}')).toEqual({
      docs: 0,
      indexes: 0,
      dbSizeBytes: 16384,
      memoryBytes: null,
    });
  });

  it('rejects non-stats payloads', () => {
    expect(parseMeiliStats('')).toBeNull();
    expect(parseMeiliStats('MISSING_AUTHORIZATION_HEADER')).toBeNull();
    expect(parseMeiliStats('{"message":"unauthorized"}')).toBeNull();
    expect(parseMeiliStats('[1,2,3]')).toBeNull();
  });
});

const TS_COLLECTIONS = JSON.stringify([
  { name: 'products', num_documents: 1200, num_memory_shards: 4 },
  { name: 'users', num_documents: 300 },
]);
const TS_METRICS = JSON.stringify({
  system_memory_used_bytes: '1000000000',
  typesense_memory_active_bytes: '29630464',
  typesense_memory_allocated_bytes: '27886840',
});

describe('parseTypesenseStats — /collections + /metrics.json lines → sample', () => {
  it('sums documents, counts collections and reads active memory', () => {
    expect(parseTypesenseStats(`${TS_COLLECTIONS}\n${TS_METRICS}`)).toEqual({
      docs: 1500,
      indexes: 2,
      dbSizeBytes: null,
      memoryBytes: 29630464,
    });
  });

  it('tolerates a missing metrics line (memory null)', () => {
    expect(parseTypesenseStats(TS_COLLECTIONS)).toEqual({
      docs: 1500,
      indexes: 2,
      dbSizeBytes: null,
      memoryBytes: null,
    });
  });

  it('tolerates a missing collections line (zero docs, metrics only)', () => {
    const s = parseTypesenseStats(TS_METRICS);
    expect(s).toEqual({ docs: 0, indexes: 0, dbSizeBytes: null, memoryBytes: 29630464 });
  });

  it('falls back to system memory when active bytes are absent', () => {
    const s = parseTypesenseStats('{"system_memory_used_bytes":"512"}');
    expect(s?.memoryBytes).toBe(512);
  });

  it('rejects payloads with no parsable line', () => {
    expect(parseTypesenseStats('')).toBeNull();
    expect(parseTypesenseStats('Forbidden - a valid `x-typesense-api-key` is required')).toBeNull();
  });
});

describe('parseSearchStats — engine dispatch', () => {
  it('routes by engine', () => {
    expect(parseSearchStats('meilisearch', MEILI_STATS)?.indexes).toBe(2);
    expect(parseSearchStats('typesense', TS_COLLECTIONS)?.indexes).toBe(2);
  });
});

describe('stats label codec', () => {
  it('round-trips through the label', () => {
    const stats = {
      docs: 20000,
      indexes: 2,
      dbSizeBytes: 447819776,
      memoryBytes: null,
      at: '2026-07-02T10:00:00.000Z',
    };
    expect(parseSearchStatsLabel(encodeSearchStatsLabel(stats))).toEqual(stats);
  });

  it('degrades malformed/foreign labels to null', () => {
    expect(parseSearchStatsLabel(undefined)).toBeNull();
    expect(parseSearchStatsLabel('not json')).toBeNull();
    expect(parseSearchStatsLabel('{"foo":1}')).toBeNull();
  });
});

describe('searchInstanceSpec — spec builder', () => {
  const meili = searchInstanceSpec({ stack: 'shop', name: 'main', engine: 'meilisearch' });
  const ts = searchInstanceSpec({ stack: 'shop', name: 'find', engine: 'typesense' });

  it('derives names, image and single-replica mode', () => {
    expect(meili.name).toBe('shop_main-search');
    expect(meili.image).toBe('getmeili/meilisearch:v1.12');
    expect(meili.mode).toEqual({ replicated: { replicas: 1 } });
    expect(ts.image).toBe('typesense/typesense:27.1');
  });

  it('is private-only: never publishes ports', () => {
    expect(meili.ports).toBeUndefined();
    expect(ts.ports).toBeUndefined();
  });

  it('mounts the data volume at the engine data dir', () => {
    expect(meili.mounts).toEqual([
      { type: 'volume', source: 'shop_main-search-data', target: '/meili_data' },
    ]);
    expect(ts.mounts).toEqual([
      { type: 'volume', source: 'shop_find-search-data', target: '/data' },
    ]);
  });

  it('mounts the key secret and reads it via the sh wrapper — never in env', () => {
    expect(meili.secrets).toEqual([
      { source: 'swarmy-search-shop_main-key', target: SEARCH_SECRET_TARGET },
    ]);
    expect(meili.command).toEqual(['sh', '-c']);
    expect(meili.args?.[0]).toContain(`cat /run/secrets/${SEARCH_SECRET_TARGET}`);
    expect(meili.args?.[0]).toContain('MEILI_MASTER_KEY');
    expect(meili.env).toBeUndefined();
    expect(ts.args?.[0]).toContain('--api-key');
    expect(ts.args?.[0]).toContain(`cat /run/secrets/${SEARCH_SECRET_TARGET}`);
    expect(ts.env).toBeUndefined();
  });

  it('stamps the swarmy.search.* label scheme', () => {
    expect(meili.labels).toMatchObject({
      'swarmy.managed': 'true',
      'com.docker.stack.namespace': 'shop',
      'swarmy.search.engine': 'meilisearch',
      'swarmy.search.cluster': 'main',
      'swarmy.scaleToZero.exempt': 'true',
    });
  });
});

describe('searchAttachEnv — injected app env', () => {
  it('meilisearch: MEILI_HOST + key file', () => {
    expect(searchAttachEnv('meilisearch', 'shop_main-search', 'swarmy-search-shop_main-key')).toEqual({
      MEILI_HOST: 'http://shop_main-search:7700',
      MEILI_MASTER_KEY_FILE: '/run/secrets/swarmy-search-shop_main-key',
    });
    expect(searchInjectVar('meilisearch')).toBe('MEILI_HOST');
  });

  it('typesense: host/port/protocol + key file', () => {
    expect(searchAttachEnv('typesense', 'shop_find-search', 'swarmy-search-shop_find-key')).toEqual({
      TYPESENSE_HOST: 'shop_find-search',
      TYPESENSE_PORT: '8108',
      TYPESENSE_PROTOCOL: 'http',
      TYPESENSE_API_KEY_FILE: '/run/secrets/swarmy-search-shop_find-key',
    });
    expect(searchInjectVar('typesense')).toBe('TYPESENSE_HOST');
  });
});

describe('in-container commands', () => {
  it('stats commands hit the right port with the key from the secret file', () => {
    const meili = searchStatsCommand('meilisearch');
    expect(meili).toContain('localhost:7700/stats');
    expect(meili).toContain(`cat /run/secrets/${SEARCH_SECRET_TARGET}`);
    expect(meili).toContain('Authorization: Bearer');
    const ts = searchStatsCommand('typesense');
    expect(ts).toContain('localhost:8108/collections');
    expect(ts).toContain('metrics.json');
    expect(ts).toContain('X-TYPESENSE-API-KEY');
  });

  it('dump command POSTs /dumps and polls the task, bounded', () => {
    const cmd = meiliDumpCommand();
    expect(cmd).toContain('POST');
    expect(cmd).toContain('/dumps');
    expect(cmd).toContain('/tasks/$TASK');
    expect(cmd).toContain('sleep 1');
  });
});

describe('naming', () => {
  it('derives service + secret names from <stack>_<name>', () => {
    expect(searchServiceName('shop', 'main')).toBe('shop_main-search');
    expect(searchKeySecretName('shop', 'main')).toBe('swarmy-search-shop_main-key');
  });
});
