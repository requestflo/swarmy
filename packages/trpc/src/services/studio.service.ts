/**
 * Database studio (plans/epic-developer-platform.md §3): browse, edit, query
 * and profile an app's databases — managed Postgres clusters and compose
 * MySQL/MariaDB/Postgres/Mongo/Redis/Valkey services — from the dashboard.
 *
 * The controller never connects to a database and nothing is published: every
 * operation is ONE `db.query` agent command on the node running the DB task,
 * which runs the engine's own client inside that task with credentials the
 * task itself resolves (the compose-dump recipe). See `@swarmy/core/protocol`
 * `studio.ts`.
 *
 * Every statement is classified here first (`@swarmy/core/studio`) and gated
 * on the policy engine against the DB service as the resource (its Docker
 * labels, so `swarmy.env=production` matters):
 *   read → `data.read` · write → `data.write` · destructive → `data.destroy`
 *   + the database name typed back · blocked → never dispatched.
 * Every run — reads included, browse and schema too — writes one `studio.query`
 * audit row: statement, who, where, how long, how many rows. Never values.
 *
 * Docker is the truth for which databases exist; the history view reads the
 * audit rows; saved queries are the one table (`StudioSavedQuery`).
 */
import { TRPCError } from '@trpc/server';
import { STACK_LABEL } from '@swarmy/core';
import {
  STUDIO_DEFAULTS,
  STUDIO_ERROR,
  resolveAppDbCreds,
  envRecordOf,
  type AppDbCredResolution,
  type DbQueryResult,
  type StudioEngine,
  type StudioOp,
  type SwarmServiceInfo,
} from '@swarmy/core/protocol';
import {
  browseSql,
  classifyMongo,
  classifyRedis,
  classifySql,
  deleteRowSql,
  inferFields,
  insertRowSql,
  mongoBrowseCommand,
  mongoDeleteById,
  mongoInsert,
  mongoProfileCommand,
  mongoSampleCommand,
  mongoUpdateById,
  MYSQL_ACTIVITY_SQL,
  MYSQL_INSIGHTS_PROBE_SQL,
  mysqlDigestSql,
  mysqlSlowLogSql,
  parseMongoInput,
  parseRelaxedJson,
  parseScanReply,
  parseSchemaJson,
  PG_ACTIVITY_SQL,
  PG_INSIGHTS_PROBE_SQL,
  pgStatStatementsSql,
  redisCommandText,
  redisRemoveArgv,
  redisScanArgv,
  redisSetArgv,
  redisValueArgv,
  schemaSql,
  singleStatementText,
  tokenizeRedis,
  updateRowSql,
  type BrowseFilter,
  type Classification,
  type RedisKeyRow,
  type SqlDialect,
  type StatementClass,
  type StudioSchema,
  type StudioTable,
  type StudioValue,
} from '@swarmy/core/studio';
import type { Action } from '@swarmy/abac';
import type { OrgContext } from '../context';
import { authorize, evaluateAccess } from '../abac';
import { badRequest, commandRejected, commandTimeout, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { detectDbEngine } from './autoBackup';
import { DB_CLUSTER_LABEL, DB_ENGINE_LABEL, DB_MEMBER_LABEL, DB_ROLE_LABEL } from './manageddb.service';
import { resolveExecTarget } from './live-resolve';

export const STUDIO_AUDIT_ACTION = 'studio.query';
/** Statement text kept on the audit row (the full text runs; the row is capped). */
const AUDIT_STATEMENT_MAX = 4000;
const MANAGED_PREFIXES = ['swarmy.db.', 'swarmy.cache.', 'swarmy.search.', 'swarmy.vector.'];

// ── targets (live Docker truth) ──────────────────────────────────────────────

export type StudioTargetKind = 'managed' | 'compose';

export interface StudioTarget {
  /** Stable id within the stack: the managed cluster name or the compose service name. */
  name: string;
  kind: StudioTargetKind;
  engine: StudioEngine;
  /** Swarm service the agent execs into (the managed primary). */
  service: string;
  serviceId: string;
  image: string;
  labels: Record<string, string>;
  creds: AppDbCredResolution;
  /** The database opened by default. */
  defaultDatabase: string | null;
}

export interface StudioTargetView {
  name: string;
  kind: StudioTargetKind;
  engine: StudioEngine;
  service: string;
  image: string;
  production: boolean;
  running: boolean;
  /** Why the studio can't open it (credentials unresolvable), else null. */
  unavailable: string | null;
  note: string | null;
  defaultDatabase: string | null;
}

function defaultDatabase(engine: StudioEngine, env: Record<string, string>, creds: AppDbCredResolution): string | null {
  if (creds.ok && creds.creds.database.length > 0) {
    const src = creds.creds.database[0]!;
    if (src.kind === 'env' && env[src.name]) return env[src.name]!;
    if (src.kind === 'literal') return src.value;
  }
  const pick = (...names: string[]) => names.map((n) => env[n]).find((v) => v && /^[A-Za-z0-9_.$-]{1,128}$/.test(v)) ?? null;
  if (engine === 'postgres') return pick('POSTGRES_DB', 'POSTGRESQL_DATABASE') ?? (env.POSTGRES_USER && /^[A-Za-z0-9_]+$/.test(env.POSTGRES_USER) ? env.POSTGRES_USER : 'postgres');
  if (engine === 'mysql' || engine === 'mariadb') return pick('MYSQL_DATABASE', 'MARIADB_DATABASE');
  if (engine === 'mongo') return pick('MONGO_INITDB_DATABASE', 'MONGODB_DATABASE');
  return null;
}

/** The studio-able databases of a stack, from the live inventory. Pure. */
export function detectStudioTargets(services: SwarmServiceInfo[], stack: string): StudioTarget[] {
  const out: StudioTarget[] = [];
  const mine = services.filter((s) => s.labels[STACK_LABEL] === stack);
  // Managed Postgres: the cluster's unregioned primary.
  for (const s of mine) {
    const cluster = s.labels[DB_CLUSTER_LABEL];
    if (!cluster || !s.labels[DB_ENGINE_LABEL] || s.labels[DB_ROLE_LABEL] !== 'primary' || s.labels[DB_MEMBER_LABEL]) continue;
    const env = envRecordOf(s.env ?? []);
    const creds = resolveAppDbCreds('postgres', s.env ?? []);
    out.push({
      name: cluster,
      kind: 'managed',
      engine: 'postgres',
      service: s.name,
      serviceId: s.id,
      image: s.image,
      labels: s.labels,
      creds,
      defaultDatabase: defaultDatabase('postgres', env, creds),
    });
  }
  // Compose databases: detected by image, never swarmy plumbing or managed members.
  for (const s of mine) {
    const engine = detectDbEngine(s.image);
    if (!engine) continue;
    if (s.name.startsWith('swarmy-') || s.labels['swarmy.system'] === 'true') continue;
    if (Object.keys(s.labels).some((k) => MANAGED_PREFIXES.some((p) => k.startsWith(p)))) continue;
    const env = envRecordOf(s.env ?? []);
    const creds = resolveAppDbCreds(engine, s.env ?? []);
    out.push({
      name: s.name,
      kind: 'compose',
      engine,
      service: s.name,
      serviceId: s.id,
      image: s.image,
      labels: s.labels,
      creds,
      defaultDatabase: defaultDatabase(engine, env, creds),
    });
  }
  return out.sort((a, b) => Number(b.kind === 'managed') - Number(a.kind === 'managed') || a.name.localeCompare(b.name));
}

function liveTargets(ctx: OrgContext, stack: string): StudioTarget[] {
  return detectStudioTargets(ctx.hub.liveInventory(ctx.activeOrgId).services, stack);
}

export function listStudioTargets(ctx: OrgContext, stack: string): StudioTargetView[] {
  return liveTargets(ctx, stack).map((t) => ({
    name: t.name,
    kind: t.kind,
    engine: t.engine,
    service: t.service,
    image: t.image,
    production: /^prod(uction)?$/i.test(t.labels['swarmy.env'] ?? ''),
    running: Boolean(resolveExecTarget(ctx, t.service)),
    unavailable: t.creds.ok ? null : t.creds.reason,
    note: t.creds.ok ? t.creds.note : null,
    defaultDatabase: t.defaultDatabase,
  }));
}

function requireTarget(ctx: OrgContext, stack: string, name: string): StudioTarget {
  const t = liveTargets(ctx, stack).find((x) => x.name === name);
  if (!t) throw notFound('database', `${stack}/${name}`);
  if (!t.creds.ok) throw commandRejected(`the studio can't sign in to ${name}: ${t.creds.reason}`);
  return t;
}

const dialectOf = (e: StudioEngine): SqlDialect => (e === 'postgres' ? 'postgres' : 'mysql');
const isSql = (e: StudioEngine) => e === 'postgres' || e === 'mysql' || e === 'mariadb';
const isKv = (e: StudioEngine) => e === 'redis' || e === 'valkey';

// ── statements: parse + classify ─────────────────────────────────────────────

export interface PreparedStatement {
  /** What the user sees, audits and confirms (SQL text / JSON command / redis command line). */
  display: string;
  op: StudioOp;
  classification: Classification;
  /** The policy action it needs. */
  action: Action;
  /** Destructive ⇒ the phrase to type back (the database name). */
  confirmPhrase: string | null;
}

const ACTION_FOR: Record<StatementClass, Action> = { read: 'data.read', write: 'data.write', destructive: 'data.destroy' };

/** Console text → the op the agent runs, with its verdict. Throws BAD_REQUEST on unparseable input. */
export function prepareStatement(engine: StudioEngine, text: string, name: string): PreparedStatement {
  let display: string;
  let classification: Classification;
  let op: StudioOp;
  if (isSql(engine)) {
    const dialect = dialectOf(engine);
    classification = classifySql(text, dialect);
    display = singleStatementText(text, dialect) ?? text.trim();
    op = { kind: 'sql', statement: display, access: classification.class === 'read' ? 'read' : 'write' };
  } else if (engine === 'mongo') {
    let doc: Record<string, unknown>;
    try {
      doc = parseMongoInput(text).doc;
    } catch (e) {
      throw badRequest(`could not read the command: ${e instanceof Error ? e.message : String(e)}`);
    }
    classification = classifyMongo(doc);
    display = JSON.stringify(doc);
    op = { kind: 'mongo', command: display, access: classification.class === 'read' ? 'read' : 'write' };
  } else {
    let argv: string[];
    try {
      argv = tokenizeRedis(text);
    } catch (e) {
      throw badRequest(`could not read the command: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (argv.length === 0) throw badRequest('empty command');
    classification = classifyRedis(argv);
    display = redisCommandText(argv);
    op = { kind: 'redis', argv, access: classification.class === 'read' ? 'read' : 'write' };
  }
  return {
    display,
    op,
    classification,
    action: ACTION_FOR[classification.class],
    confirmPhrase: classification.class === 'destructive' ? name : null,
  };
}

// ── gate + run + audit ───────────────────────────────────────────────────────

export type StudioOrigin = 'console' | 'browse' | 'schema' | 'edit' | 'insights' | 'saved';

export interface StudioRunView extends DbQueryResult {
  statement: string;
  classification: Classification;
  database: string | null;
}

function resourceOf(ctx: OrgContext, t: StudioTarget) {
  return { type: 'service', id: t.serviceId, orgId: ctx.activeOrgId, labels: t.labels };
}

/**
 * The policy gate. Reads go through `evaluateAccess` and are recorded ONCE,
 * on the `studio.query` row (with the deciding policy); writes and destructive
 * statements go through `authorize`, which writes its own permit/deny row too.
 */
async function gate(ctx: OrgContext, t: StudioTarget, p: PreparedStatement, confirm?: string): Promise<string | null> {
  if (p.classification.blocked) throw badRequest(p.classification.blocked);
  if (p.classification.class === 'destructive' && (confirm ?? '').trim() !== t.name) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `destructive statement (${p.classification.reasons.join('; ') || p.classification.kind}) — type ${t.name} to confirm`,
      cause: { swarmyCode: 'CONFIRM_REQUIRED', phrase: t.name },
    });
  }
  if (p.action === 'data.read') {
    const res = await evaluateAccess(ctx, 'data.read', resourceOf(ctx, t));
    if (res.decision === 'deny') {
      await writeAudit(ctx, { action: 'authz.deny:data.read', targetType: 'service', targetId: t.serviceId, metadata: { policyId: res.policyId, reasons: res.reasons } });
      throw new TRPCError({ code: 'FORBIDDEN', message: 'not permitted: data.read', cause: { swarmyCode: 'POLICY_DENIED', policyId: res.policyId } });
    }
    return res.policyId;
  }
  const g = await authorize(ctx, p.action, resourceOf(ctx, t));
  return g.policyId;
}

function mapStudioError(e: unknown): TRPCError {
  if (e instanceof TRPCError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const m = /(E_STUDIO_[A-Z_]+): ([\s\S]*)$/.exec(msg);
  if (m) {
    const [, code, text] = m;
    if (code === STUDIO_ERROR.timeout) return new TRPCError({ code: 'TIMEOUT', message: text!, cause: { swarmyCode: code } });
    if (code === STUDIO_ERROR.refused) return new TRPCError({ code: 'BAD_REQUEST', message: text!, cause: { swarmyCode: code } });
    return new TRPCError({ code: 'BAD_REQUEST', message: text!, cause: { swarmyCode: code } });
  }
  if (/timeout/i.test(msg)) return commandTimeout();
  return commandRejected(msg);
}

export interface RunOptions {
  database?: string | null;
  dbIndex?: number;
  confirm?: string;
  origin: StudioOrigin;
  rowCap?: number;
  statementTimeoutMs?: number;
}

async function runPrepared(ctx: OrgContext, t: StudioTarget, p: PreparedStatement, o: RunOptions): Promise<StudioRunView> {
  const policyId = await gate(ctx, t, p, o.confirm);
  const database = isKv(t.engine) ? null : (o.database ?? t.defaultDatabase);
  const limits = {
    statementTimeoutMs: o.statementTimeoutMs ?? STUDIO_DEFAULTS.statementTimeoutMs,
    rowCap: o.rowCap ?? STUDIO_DEFAULTS.rowCap,
    maxBytes: STUDIO_DEFAULTS.maxBytes,
  };
  const started = Date.now();
  const audit = (metadata: Record<string, unknown>) =>
    writeAudit(ctx, {
      action: STUDIO_AUDIT_ACTION,
      targetType: 'database',
      targetId: `${t.labels[STACK_LABEL] ?? ''}/${t.name}`,
      metadata: {
        engine: t.engine,
        origin: o.origin,
        statement: p.display.length > AUDIT_STATEMENT_MAX ? `${p.display.slice(0, AUDIT_STATEMENT_MAX)}…` : p.display,
        class: p.classification.class,
        kind: p.classification.kind,
        database: database ?? (o.dbIndex != null ? `db${o.dbIndex}` : null),
        policyId,
        ...metadata,
      },
    });
  const exec = resolveExecTarget(ctx, t.service);
  if (!exec) {
    await audit({ status: 'failed', error: 'no running task', durationMs: 0 });
    throw commandRejected(`${t.name} has no running task to query`);
  }
  try {
    const r = await ctx.hub.dispatch<DbQueryResult>(
      exec.nodeId,
      'db.query',
      {
        engine: t.engine,
        service: t.service,
        creds: t.creds.ok ? t.creds.creds : undefined,
        ...(database ? { database } : {}),
        ...(o.dbIndex != null ? { dbIndex: o.dbIndex } : {}),
        op: p.op,
        limits,
      },
      { timeoutMs: limits.statementTimeoutMs + 20_000 },
    );
    await audit({
      status: 'ok',
      durationMs: Date.now() - started,
      rows: r.rowCount,
      ...(r.affected != null ? { affected: r.affected } : {}),
      truncated: r.truncated,
    });
    return { ...r, statement: p.display, classification: p.classification, database };
  } catch (e) {
    const err = mapStudioError(e);
    await audit({ status: 'failed', durationMs: Date.now() - started, error: err.message.slice(0, 500) });
    throw err;
  }
}

/** Console: run what the user typed (any engine), gated by its classification. */
export async function executeStudio(
  ctx: OrgContext,
  input: { stack: string; target: string; statement: string; database?: string | null; dbIndex?: number; confirm?: string; origin?: 'console' | 'edit' | 'saved' },
): Promise<StudioRunView> {
  const t = requireTarget(ctx, input.stack, input.target);
  const p = prepareStatement(t.engine, input.statement, t.name);
  return runPrepared(ctx, t, p, { database: input.database, dbIndex: input.dbIndex, confirm: input.confirm, origin: input.origin ?? 'console' });
}

/** Classify without running (the server's verdict; the dashboard also classifies live). */
export function previewStudio(ctx: OrgContext, input: { stack: string; target: string; statement: string }): Omit<PreparedStatement, 'op'> {
  const t = requireTarget(ctx, input.stack, input.target);
  const { op: _op, ...rest } = prepareStatement(t.engine, input.statement, t.name);
  return rest;
}

// ── schema ───────────────────────────────────────────────────────────────────

export interface StudioSchemaView extends StudioSchema {
  engine: StudioEngine;
  /** Redis/Valkey: logical databases with keys (`db0` → count). */
  keyspaces?: Array<{ index: number; keys: number }>;
}

const internal = (engine: StudioEngine, text: string) => {
  const p = prepareStatement(engine, text, '');
  return { ...p, confirmPhrase: null };
};

export async function studioSchema(ctx: OrgContext, input: { stack: string; target: string; database?: string | null }): Promise<StudioSchemaView> {
  const t = requireTarget(ctx, input.stack, input.target);
  if (isSql(t.engine)) {
    const dialect = dialectOf(t.engine);
    const run = async (database: string | null) => {
      const r = await runPrepared(ctx, t, internal(t.engine, schemaSql(dialect)), { database, origin: 'schema', rowCap: 1 });
      const cell = r.rows[0]?.[0];
      if (typeof cell !== 'string') throw commandRejected('the schema query returned nothing');
      if (r.truncated) throw commandRejected('the schema is larger than the studio can read in one go');
      return parseSchemaJson(dialect, cell);
    };
    let s = await run(input.database ?? t.defaultDatabase);
    // MySQL root scope with no database picked: open the first user database.
    if (!s.database && s.databases.length > 0 && dialect === 'mysql') s = await run(s.databases[0]!);
    return { ...s, engine: t.engine };
  }
  if (t.engine === 'mongo') {
    const database = input.database ?? t.defaultDatabase;
    const [dbs, colls, build] = await Promise.all([
      runPrepared(ctx, t, internal('mongo', '{"listDatabases": 1, "nameOnly": true}'), { database: 'admin', origin: 'schema' }).catch(() => null),
      runPrepared(ctx, t, internal('mongo', '{"listCollections": 1, "nameOnly": false}'), { database, origin: 'schema' }),
      runPrepared(ctx, t, internal('mongo', '{"buildInfo": 1}'), { database: 'admin', origin: 'schema' }).catch(() => null),
    ]);
    const dbReply = dbs?.reply as { databases?: Array<{ name: string }> } | undefined;
    const databases = (dbReply?.databases ?? []).map((d) => d.name).filter((n) => !['admin', 'config', 'local'].includes(n));
    const tables: StudioTable[] = (colls.documents ?? [])
      .map((d) => d as { name: string; type?: string })
      .filter((d) => d.name && !d.name.startsWith('system.'))
      .map((d) => ({ schema: null, name: d.name, type: d.type === 'view' ? 'view' : 'collection', rowsEstimate: null, bytes: null, columns: [], indexes: [], keyColumns: ['_id'] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      engine: t.engine,
      version: (build?.reply as { version?: string } | undefined)?.version ?? null,
      database: database ?? null,
      databases: database && !databases.includes(database) ? [database, ...databases] : databases,
      tables,
    };
  }
  // Redis / Valkey: INFO keyspace + server version.
  const info = await runPrepared(ctx, t, internal(t.engine, 'INFO'), { origin: 'schema' });
  const text = typeof info.reply === 'string' ? info.reply : '';
  const version = /^(?:redis|valkey)_version:(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const keyspaces = [...text.matchAll(/^db(\d+):keys=(\d+)/gm)].map((m) => ({ index: Number(m[1]), keys: Number(m[2]) }));
  return { engine: t.engine, version, database: null, databases: [], tables: [], keyspaces };
}

/** Mongo: a collection's inferred fields (sampled), indexes and count. */
export async function studioCollection(
  ctx: OrgContext,
  input: { stack: string; target: string; database?: string | null; collection: string },
): Promise<StudioTable & { sampled: number }> {
  const t = requireTarget(ctx, input.stack, input.target);
  if (t.engine !== 'mongo') throw badRequest('collections are a Mongo concept');
  const database = input.database ?? t.defaultDatabase;
  const c = JSON.stringify(input.collection);
  const [sample, idx, count] = await Promise.all([
    runPrepared(ctx, t, internal('mongo', JSON.stringify(mongoSampleCommand(input.collection))), { database, origin: 'schema' }),
    runPrepared(ctx, t, internal('mongo', `{"listIndexes": ${c}}`), { database, origin: 'schema' }).catch(() => null),
    runPrepared(ctx, t, internal('mongo', `{"count": ${c}}`), { database, origin: 'schema' }).catch(() => null),
  ]);
  const fields = inferFields(sample.documents ?? []);
  const indexes = (idx?.documents ?? []).map((d) => {
    const i = d as { name: string; key: Record<string, unknown>; unique?: boolean };
    return { name: i.name, columns: Object.keys(i.key ?? {}), primary: i.name === '_id_', unique: Boolean(i.unique) || i.name === '_id_', definition: JSON.stringify(i.key) };
  });
  const n = (count?.reply as { n?: number } | undefined)?.n;
  return {
    schema: null,
    name: input.collection,
    type: 'collection',
    rowsEstimate: typeof n === 'number' ? n : null,
    bytes: null,
    columns: fields.map((f) => ({ name: f.name, type: f.types.join(' | '), nullable: f.seen < (sample.documents?.length ?? 0) || f.types.includes('null'), default: null, key: f.name === '_id' })),
    indexes,
    keyColumns: ['_id'],
    sampled: sample.documents?.length ?? 0,
  };
}

// ── browse ───────────────────────────────────────────────────────────────────

export interface StudioBrowseInput {
  stack: string;
  target: string;
  database?: string | null;
  table: { schema?: string | null; name: string };
  page: number;
  pageSize: number;
  orderBy?: string | null;
  dir?: 'asc' | 'desc';
  filters?: BrowseFilter[];
  /** Mongo: a filter document (relaxed JSON). */
  mongoFilter?: string;
}

export interface StudioBrowseView {
  statement: string;
  columns: string[];
  rows: unknown[][];
  documents?: unknown[];
  hasMore: boolean;
  durationMs: number;
}

export async function studioBrowse(ctx: OrgContext, input: StudioBrowseInput): Promise<StudioBrowseView> {
  const t = requireTarget(ctx, input.stack, input.target);
  const limit = input.pageSize;
  const offset = input.page * input.pageSize;
  let text: string;
  if (isSql(t.engine)) {
    text = browseSql(dialectOf(t.engine), { table: input.table, limit, offset, orderBy: input.orderBy, dir: input.dir, filters: input.filters });
  } else if (t.engine === 'mongo') {
    let filter: Record<string, unknown> = {};
    if (input.mongoFilter?.trim()) {
      try {
        const f = parseRelaxedJson(input.mongoFilter);
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('the filter must be a document');
        filter = f as Record<string, unknown>;
      } catch (e) {
        throw badRequest(`filter: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    text = JSON.stringify(mongoBrowseCommand({ collection: input.table.name, filter, limit, skip: offset, ...(input.orderBy ? { sort: { [input.orderBy]: input.dir === 'desc' ? -1 : 1 } } : {}) }));
  } else {
    throw badRequest('Redis/Valkey keys are browsed with studio.keys');
  }
  const r = await runPrepared(ctx, t, internal(t.engine, text), { database: input.database, origin: 'browse', rowCap: limit + 1 });
  const hasMore = r.rows.length > limit;
  return {
    statement: r.statement,
    columns: r.columns,
    rows: r.rows.slice(0, limit),
    ...(r.documents ? { documents: r.documents.slice(0, limit) } : {}),
    hasMore,
    durationMs: r.durationMs,
  };
}

/** Redis/Valkey key browser: one bounded SCAN page with type / TTL / size. */
export async function studioKeys(
  ctx: OrgContext,
  input: { stack: string; target: string; dbIndex?: number; pattern?: string; cursor?: string; count?: number },
): Promise<{ cursor: string; keys: RedisKeyRow[]; durationMs: number }> {
  const t = requireTarget(ctx, input.stack, input.target);
  if (!isKv(t.engine)) throw badRequest('keys are a Redis/Valkey concept');
  const argv = redisScanArgv(input.cursor ?? '0', input.pattern || '*', input.count ?? 200);
  const p: PreparedStatement = {
    display: `SCAN ${argv[3]} MATCH ${argv[4]} COUNT ${argv[5]} (+ TYPE / PTTL / size per key)`,
    op: { kind: 'redis', argv, access: 'read' },
    classification: { class: 'read', kind: 'SCAN', reasons: [] },
    action: 'data.read',
    confirmPhrase: null,
  };
  const r = await runPrepared(ctx, t, p, { dbIndex: input.dbIndex, origin: 'browse' });
  const page = parseScanReply(r.reply);
  return { ...page, keys: page.keys.sort((a, b) => a.key.localeCompare(b.key)), durationMs: r.durationMs };
}

export async function studioKeyValue(
  ctx: OrgContext,
  input: { stack: string; target: string; dbIndex?: number; key: string; type: string },
): Promise<StudioRunView> {
  const t = requireTarget(ctx, input.stack, input.target);
  if (!isKv(t.engine)) throw badRequest('keys are a Redis/Valkey concept');
  const argv = redisValueArgv(input.type, input.key, 500);
  const p = prepareStatement(t.engine, redisCommandText(argv), t.name);
  return runPrepared(ctx, t, p, { dbIndex: input.dbIndex, origin: 'browse', rowCap: 1000 });
}

// ── row edits (built here, shown to the user, then run via execute) ──────────

export type StudioEdit =
  | { kind: 'update'; table: { schema?: string | null; name: string }; key: Record<string, StudioValue>; set: Record<string, StudioValue> }
  | { kind: 'insert'; table: { schema?: string | null; name: string }; values: Record<string, StudioValue> }
  | { kind: 'delete'; table: { schema?: string | null; name: string }; key: Record<string, StudioValue> }
  | { kind: 'mongoUpdate'; collection: string; id?: unknown; set: Record<string, unknown>; unset?: string[] }
  | { kind: 'mongoInsert'; collection: string; doc: Record<string, unknown> }
  | { kind: 'mongoDelete'; collection: string; id?: unknown }
  | { kind: 'redisSet'; type: string; key: string; field: string | null; value: string }
  | { kind: 'redisRemove'; type: string; key: string; member: string | null };

/** The exact statement an edit will run, with its verdict — nothing runs here. */
export function prepareEdit(ctx: OrgContext, input: { stack: string; target: string; edit: StudioEdit }): Omit<PreparedStatement, 'op'> {
  const t = requireTarget(ctx, input.stack, input.target);
  const e = input.edit;
  let text: string;
  try {
    if (e.kind === 'update' || e.kind === 'insert' || e.kind === 'delete') {
      if (!isSql(t.engine)) throw new Error('row edits need a SQL database');
      const d = dialectOf(t.engine);
      text = e.kind === 'update' ? updateRowSql(d, e.table, e.key, e.set) : e.kind === 'insert' ? insertRowSql(d, e.table, e.values) : deleteRowSql(d, e.table, e.key);
    } else if (e.kind === 'mongoUpdate' || e.kind === 'mongoInsert' || e.kind === 'mongoDelete') {
      if (t.engine !== 'mongo') throw new Error('document edits need Mongo');
      text = JSON.stringify(
        e.kind === 'mongoUpdate' ? mongoUpdateById(e.collection, e.id, e.set, e.unset) : e.kind === 'mongoInsert' ? mongoInsert(e.collection, e.doc) : mongoDeleteById(e.collection, e.id),
      );
    } else {
      if (!isKv(t.engine)) throw new Error('key edits need Redis/Valkey');
      text = redisCommandText(e.kind === 'redisSet' ? redisSetArgv(e.type, e.key, e.field, e.value) : redisRemoveArgv(e.type, e.key, e.member));
    }
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : String(err));
  }
  const { op: _op, ...rest } = prepareStatement(t.engine, text, t.name);
  return rest;
}

// ── insights ─────────────────────────────────────────────────────────────────

export interface StudioInsightsView {
  engine: StudioEngine;
  /** Where the slow-query list came from, or null when no source is available. */
  source: 'pg_stat_statements' | 'performance_schema' | 'slow_log' | 'profiler' | 'slowlog' | null;
  /** Why there is no source, and how to turn one on. */
  unavailable: { reason: string; hint: string } | null;
  slow: Array<{ query: string; calls: number | null; totalMs: number | null; meanMs: number | null; rows: number | null; at?: string | null }>;
  /** What is running right now (SQL engines), longest first. */
  active: Array<{ pid: string; user: string | null; state: string | null; seconds: number | null; query: string }>;
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function rowsAsObjects(r: { columns: string[]; rows: unknown[][] }): Array<Record<string, unknown>> {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

export async function studioInsights(ctx: OrgContext, input: { stack: string; target: string; database?: string | null }): Promise<StudioInsightsView> {
  const t = requireTarget(ctx, input.stack, input.target);
  const o = { database: input.database, origin: 'insights' as const, rowCap: 50 };
  const run = (text: string) => runPrepared(ctx, t, internal(t.engine, text), o);
  const slowOf = (r: StudioRunView) =>
    rowsAsObjects(r).map((x) => ({ query: str(x.query), calls: num(x.calls), totalMs: num(x.total_ms), meanMs: num(x.mean_ms), rows: num(x.rows), ...(x.start_time ? { at: str(x.start_time) } : {}) }));
  const activeOf = (r: StudioRunView) =>
    rowsAsObjects(r).map((x) => ({ pid: str(x.pid), user: x.user == null ? null : str(x.user), state: x.state == null ? null : str(x.state), seconds: num(x.seconds), query: str(x.query) }));

  if (t.engine === 'postgres') {
    const [probe, active] = await Promise.all([run(PG_INSIGHTS_PROBE_SQL), run(PG_ACTIVITY_SQL).catch(() => null)]);
    const p = rowsAsObjects(probe)[0] ?? {};
    const preloaded = /pg_stat_statements/.test(str(p.preload));
    if (p.ext != null && preloaded) {
      const slow = await run(pgStatStatementsSql(num(p.v13) === 1));
      return { engine: t.engine, source: 'pg_stat_statements', unavailable: null, slow: slowOf(slow), active: active ? activeOf(active) : [] };
    }
    return {
      engine: t.engine,
      source: null,
      unavailable: preloaded
        ? { reason: 'pg_stat_statements is loaded but not installed in this database', hint: 'Run CREATE EXTENSION pg_stat_statements in the console (an admin action).' }
        : { reason: 'pg_stat_statements is not loaded', hint: "Add shared_preload_libraries='pg_stat_statements' to the server command and restart it, then CREATE EXTENSION pg_stat_statements." },
      slow: [],
      active: active ? activeOf(active) : [],
    };
  }
  if (t.engine === 'mysql' || t.engine === 'mariadb') {
    const [probe, active] = await Promise.all([run(MYSQL_INSIGHTS_PROBE_SQL), run(MYSQL_ACTIVITY_SQL).catch(() => null)]);
    const p = rowsAsObjects(probe)[0] ?? {};
    const act = active ? activeOf(active) : [];
    if (num(p.ps) === 1) {
      const r = await run(mysqlDigestSql()).catch(() => null);
      if (r) return { engine: t.engine, source: 'performance_schema', unavailable: null, slow: slowOf(r), active: act };
    }
    if (num(p.slow) === 1 && /TABLE/i.test(str(p.output))) {
      const r = await run(mysqlSlowLogSql()).catch(() => null);
      if (r) return { engine: t.engine, source: 'slow_log', unavailable: null, slow: slowOf(r), active: act };
    }
    return {
      engine: t.engine,
      source: null,
      unavailable: {
        reason: num(p.slow) === 1 ? `the slow log writes to ${str(p.output) || 'a file'}, which the studio can't read` : 'performance_schema and the slow query log are both off',
        hint: 'Start the server with --performance-schema=ON, or --slow-query-log=ON --log-output=TABLE.',
      },
      slow: [],
      active: act,
    };
  }
  if (t.engine === 'mongo') {
    const level = await run('{"profile": -1}');
    const lv = num((level.reply as { was?: number } | null)?.was);
    if (lv != null && lv > 0) {
      const r = await run(JSON.stringify(mongoProfileCommand()));
      return {
        engine: t.engine,
        source: 'profiler',
        unavailable: null,
        slow: (r.documents ?? []).map((d) => {
          const x = d as { op?: string; ns?: string; command?: unknown; millis?: number; ts?: unknown; nreturned?: number };
          return { query: `${x.op ?? ''} ${x.ns ?? ''} ${x.command ? JSON.stringify(x.command) : ''}`.trim(), calls: 1, totalMs: num(x.millis), meanMs: num(x.millis), rows: num(x.nreturned), at: x.ts ? str((x.ts as { $date?: string }).$date ?? x.ts) : null };
        }),
        active: [],
      };
    }
    return {
      engine: t.engine,
      source: null,
      unavailable: { reason: 'the profiler is off for this database', hint: 'Run {"profile": 1, "slowms": 100} in the console to record operations slower than 100 ms (a write).' },
      slow: [],
      active: [],
    };
  }
  const r = await run('SLOWLOG GET 25');
  const entries = Array.isArray(r.reply) ? (r.reply as unknown[]) : [];
  return {
    engine: t.engine,
    source: 'slowlog',
    unavailable: null,
    slow: entries
      .filter((e): e is unknown[] => Array.isArray(e))
      .map((e) => ({ query: Array.isArray(e[3]) ? (e[3] as unknown[]).map(String).join(' ') : '', calls: 1, totalMs: num(e[2]) != null ? num(e[2])! / 1000 : null, meanMs: num(e[2]) != null ? num(e[2])! / 1000 : null, rows: null, at: num(e[1]) ? new Date(num(e[1])! * 1000).toISOString() : null })),
    active: [],
  };
}

// ── history (audit rows) + saved queries ─────────────────────────────────────

export interface StudioHistoryRow {
  id: string;
  at: string;
  statement: string;
  class: StatementClass;
  status: 'ok' | 'failed';
  durationMs: number | null;
  rows: number | null;
  affected: number | null;
  error: string | null;
  database: string | null;
}

/** The caller's own console runs on this database, newest first — from the audit log. */
export async function studioHistory(ctx: OrgContext, input: { stack: string; target: string; limit?: number }): Promise<StudioHistoryRow[]> {
  const rows = await ctx.db.auditLog.findMany({
    where: { orgId: ctx.activeOrgId, action: STUDIO_AUDIT_ACTION, targetType: 'database', targetId: `${input.stack}/${input.target}`, actorId: ctx.user.id },
    orderBy: { ts: 'desc' },
    take: 200,
    select: { id: true, ts: true, metadata: true },
  });
  const out: StudioHistoryRow[] = [];
  for (const r of rows) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    if (m.origin !== 'console' && m.origin !== 'edit' && m.origin !== 'saved') continue;
    out.push({
      id: String(r.id),
      at: r.ts.toISOString(),
      statement: str(m.statement),
      class: (['read', 'write', 'destructive'].includes(String(m.class)) ? m.class : 'read') as StatementClass,
      status: m.status === 'ok' ? 'ok' : 'failed',
      durationMs: num(m.durationMs),
      rows: num(m.rows),
      affected: num(m.affected),
      error: m.error == null ? null : str(m.error),
      database: m.database == null ? null : str(m.database),
    });
    if (out.length >= (input.limit ?? 50)) break;
  }
  return out;
}

export interface StudioSavedQueryView {
  id: string;
  name: string;
  target: string | null;
  engine: string;
  statement: string;
  createdById: string | null;
  updatedAt: string;
}

const savedView = (r: { id: string; name: string; target: string | null; engine: string; statement: string; createdById: string | null; updatedAt: Date }): StudioSavedQueryView => ({
  id: r.id,
  name: r.name,
  target: r.target,
  engine: r.engine,
  statement: r.statement,
  createdById: r.createdById,
  updatedAt: r.updatedAt.toISOString(),
});

export async function listSavedQueries(ctx: OrgContext, input: { stack: string }): Promise<StudioSavedQueryView[]> {
  const rows = await ctx.db.studioSavedQuery.findMany({ where: { orgId: ctx.activeOrgId, stack: input.stack }, orderBy: { name: 'asc' } });
  return rows.map(savedView);
}

export async function saveQuery(
  ctx: OrgContext,
  input: { stack: string; target?: string | null; engine: StudioEngine; name: string; statement: string; id?: string },
): Promise<StudioSavedQueryView> {
  const data = { target: input.target ?? null, engine: input.engine, name: input.name.trim(), statement: input.statement };
  let row;
  if (input.id) {
    const existing = await ctx.db.studioSavedQuery.findFirst({ where: { id: input.id, orgId: ctx.activeOrgId, stack: input.stack } });
    if (!existing) throw notFound('saved query', input.id);
    row = await ctx.db.studioSavedQuery.update({ where: { id: existing.id }, data });
  } else {
    const clash = await ctx.db.studioSavedQuery.findFirst({ where: { orgId: ctx.activeOrgId, stack: input.stack, name: data.name } });
    row = clash
      ? await ctx.db.studioSavedQuery.update({ where: { id: clash.id }, data })
      : await ctx.db.studioSavedQuery.create({ data: { ...data, orgId: ctx.activeOrgId, stack: input.stack, createdById: ctx.user.id } });
  }
  await writeAudit(ctx, { action: 'studio.savedQuery.save', targetType: 'stack', targetId: input.stack, metadata: { name: row.name, target: row.target } });
  return savedView(row);
}

export async function removeSavedQuery(ctx: OrgContext, input: { stack: string; id: string }): Promise<{ ok: true }> {
  const existing = await ctx.db.studioSavedQuery.findFirst({ where: { id: input.id, orgId: ctx.activeOrgId, stack: input.stack } });
  if (!existing) throw notFound('saved query', input.id);
  await ctx.db.studioSavedQuery.delete({ where: { id: existing.id } });
  await writeAudit(ctx, { action: 'studio.savedQuery.remove', targetType: 'stack', targetId: input.stack, metadata: { name: existing.name } });
  return { ok: true };
}
