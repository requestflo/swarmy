import { classifyRedis, classifySql, tokenizeRedis, type StudioTable } from '@swarmy/core/studio';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Database studio demo resolvers (`studio.*`): the storefront app's managed
 * Postgres (`db`) with a few tables and a compose Valkey (`storefront_cache`).
 * Shapes mirror `studio.service.ts`. Queries are classified with the real
 * `@swarmy/core/studio` code; results are canned; writes "affect" one row.
 */

type Row = Array<string | null>;
interface Tbl { name: string; cols: Array<[string, string]>; rows: Row[] }

const TABLES: Tbl[] = [
  { name: 'orders', cols: [['id', 'bigint'], ['customer', 'text'], ['total', 'numeric'], ['status', 'order_status'], ['created_at', 'timestamp with time zone']],
    rows: Array.from({ length: 64 }, (_, i) => [String(10491 - i), ['m.kowalski@', 'j.okoro@', 'a.lindqvist@', 's.patel@'][i % 4] + 'example.com', (12 + ((i * 37) % 200)).toFixed(2), ['paid', 'shipped', 'paid', 'refunded'][i % 4]!, `2026-09-24 ${String(10 - (i % 10)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}:00+00`]) },
  { name: 'products', cols: [['id', 'bigint'], ['name', 'text'], ['price', 'numeric'], ['stock', 'integer'], ['category', 'text']],
    rows: [['4411', 'Enamel mug · coral', '14.00', '212', 'mugs'], ['4410', 'Linen apron', '32.00', '48', 'kitchen'], ['4409', 'Walnut board', '58.00', '12', null], ['4408', 'Stoneware bowl set', '46.00', '0', 'bowls']] },
  { name: 'customers', cols: [['id', 'bigint'], ['email', 'text'], ['name', 'text'], ['created_at', 'timestamp with time zone']],
    rows: [['1', 'm.kowalski@example.com', 'Marta', '2026-01-02 10:00:00+00'], ['2', 'j.okoro@example.com', 'Jide', '2026-02-11 09:30:00+00']] },
];

const schemaTables = (): StudioTable[] =>
  TABLES.map((t) => ({
    schema: 'public', name: t.name, type: 'table', rowsEstimate: t.rows.length * (t.name === 'orders' ? 300 : 1), bytes: 81920,
    columns: t.cols.map(([name, type]) => ({ name, type, nullable: name !== 'id', default: name === 'id' ? `nextval('${t.name}_id_seq'::regclass)` : null, key: name === 'id' })),
    indexes: [{ name: `${t.name}_pkey`, columns: ['id'], primary: true, unique: true, definition: `CREATE UNIQUE INDEX ${t.name}_pkey ON public.${t.name} USING btree (id)` }],
    keyColumns: ['id'],
  }));

const KEYS = [
  { key: 'sess:7f2a91c4', type: 'hash', ttlMs: 1_380_000, size: 3 },
  { key: 'cart:19bc03', type: 'hash', ttlMs: 7_200_000, size: 2 },
  { key: 'bull:emails:wait', type: 'list', ttlMs: -1, size: 3 },
  { key: 'rate:ip:81.2.69.142', type: 'string', ttlMs: 42_000, size: 2 },
];

const TARGETS = [
  { name: 'db', kind: 'managed', engine: 'postgres', service: 'storefront_db-primary', image: 'pgvector/pgvector:pg17', production: false, running: true, unavailable: null, note: null, defaultDatabase: 'storefront' },
  { name: 'storefront_cache', kind: 'compose', engine: 'valkey', service: 'storefront_cache', image: 'valkey/valkey:8', production: false, running: true, unavailable: null, note: 'password (if any) read from the server command line / redis.conf', defaultDatabase: null },
];

const run = (base: Record<string, unknown>) => ({ columns: [], rows: [], rowCount: 0, truncated: false, notices: [], durationMs: 7, ...base });
const history: Array<Record<string, unknown>> = [];

function execute(i: unknown, s: DemoStore): unknown {
  const { target, statement } = i as { target: string; statement: string };
  const kv = target === 'storefront_cache';
  const classification = kv ? classifyRedis(tokenizeRedis(statement)) : classifySql(statement, 'postgres');
  if (classification.blocked) throw new Error(classification.blocked);
  history.unshift({ id: String(history.length + 1), at: new Date().toISOString(), statement, class: classification.class, status: 'ok', durationMs: 7, rows: 1, affected: null, error: null, database: kv ? null : 'storefront' });
  void s;
  if (classification.class !== 'read') return { ...run({ affected: 1, status: kv ? 'OK' : `${classification.kind} 1`, engine: kv ? 'valkey' : 'postgres' }), statement, classification, database: 'storefront' };
  const t = TABLES.find((x) => new RegExp(`\\b${x.name}\\b`, 'i').test(statement)) ?? TABLES[0]!;
  const rows = kv ? [['user_id', '88213'], ['cart', '19bc03']] : t.rows.slice(0, 20);
  return { ...run({ engine: kv ? 'valkey' : 'postgres', columns: kv ? ['field', 'value'] : t.cols.map((c) => c[0]), rows, rowCount: rows.length }), statement, classification, database: kv ? null : 'storefront' };
}

export const studio: DomainResolvers = {
  handlers: {
    'studio.targets': (i) => ((i as { stack?: string }).stack === 'storefront' ? TARGETS : []),
    'studio.schema': (i) =>
      (i as { target: string }).target === 'storefront_cache'
        ? { engine: 'valkey', version: '8.0.1', database: null, databases: [], tables: [], keyspaces: [{ index: 0, keys: 5784 }] }
        : { engine: 'postgres', version: '17.2', database: 'storefront', databases: ['postgres', 'storefront'], tables: schemaTables() },
    'studio.browse': (i) => {
      const { table, page, pageSize } = i as { table: { name: string }; page: number; pageSize: number };
      const t = TABLES.find((x) => x.name === table.name) ?? TABLES[0]!;
      const rows = t.rows.slice(page * pageSize, page * pageSize + pageSize);
      return { statement: `SELECT * FROM "public"."${t.name}" ORDER BY "id" DESC LIMIT ${pageSize + 1}`, columns: t.cols.map((c) => c[0]), rows, hasMore: t.rows.length > (page + 1) * pageSize, durationMs: 4 };
    },
    'studio.collection': () => null,
    'studio.keys': () => ({ cursor: '0', keys: KEYS, durationMs: 1 }),
    'studio.keyValue': (i) => {
      const { type } = i as { type: string };
      return { ...run({ engine: 'valkey', columns: type === 'string' ? ['value'] : ['field', 'value'], rows: type === 'string' ? [['17']] : [['user_id', '88213'], ['cart', '19bc03'], ['csrf', 'b7e1…']], rowCount: 3 }), statement: 'HSCAN', classification: { class: 'read', kind: 'HSCAN', reasons: [] }, database: null };
    },
    'studio.prepareEdit': (i) => {
      const { edit } = i as { edit: { kind: string; table?: { name: string }; key?: Record<string, unknown>; set?: Record<string, unknown> } };
      const where = Object.entries(edit.key ?? {}).map(([k, v]) => `"${k}" = '${String(v)}'`).join(' AND ');
      const display = edit.kind === 'delete' ? `DELETE FROM "public"."${edit.table?.name}" WHERE ${where}` : `UPDATE "public"."${edit.table?.name}" SET ${Object.entries(edit.set ?? {}).map(([k, v]) => `"${k}" = ${v === null ? 'NULL' : `'${String(v)}'`}`).join(', ')} WHERE ${where}`;
      return { display, classification: classifySql(display, 'postgres'), action: 'data.write', confirmPhrase: null };
    },
    'studio.preview': (i) => ({ display: (i as { statement: string }).statement, classification: classifySql((i as { statement: string }).statement, 'postgres'), action: 'data.read', confirmPhrase: null }),
    'studio.execute': execute,
    'studio.insights': (i) =>
      (i as { target: string }).target === 'storefront_cache'
        ? { engine: 'valkey', source: 'slowlog', unavailable: null, slow: [{ query: 'KEYS product:*', calls: 1, totalMs: 41, meanMs: 41, rows: null, at: null }], active: [] }
        : { engine: 'postgres', source: 'pg_stat_statements', unavailable: null, active: [], slow: [
            { query: 'SELECT sum(qty*price) FROM order_items WHERE cart_id = $1', calls: 12400, totalMs: 5_108_800, meanMs: 412, rows: 12400 },
            { query: 'SELECT * FROM products WHERE lower(name) LIKE $1', calls: 3100, totalMs: 582_800, meanMs: 188, rows: 9300 },
          ] },
    'studio.history': () => history.slice(0, 25),
    'studio.saved.list': () => [
      { id: 'q1', name: 'Revenue last 7 days', target: 'db', engine: 'postgres', statement: "SELECT date_trunc('day', created_at) AS day, count(*) AS orders, sum(total) AS revenue FROM orders WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1 DESC", createdById: 'user-demo', updatedAt: new Date().toISOString() },
    ],
    'studio.saved.save': (i) => ({ id: 'q2', target: null, createdById: 'user-demo', updatedAt: new Date().toISOString(), ...(i as object) }),
    'studio.saved.remove': () => ({ ok: true }),
  },
};
