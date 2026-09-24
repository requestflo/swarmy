/**
 * Database studio — the `dbQuery` command. One bounded query against a DB task
 * on THIS node, run by the engine's own client inside the task (non-interactive
 * exec → 127.0.0.1 in the task's network namespace). The flow and the trust
 * story live in `@swarmy/core/protocol` `studio.ts`; the scripts and parsers in
 * `@swarmy/core/studio/scripts` (golden-tested). This handler:
 *
 *   1. re-checks the operation (the second wall behind the controller's gate):
 *      a `read` must classify as a read, nothing blocked ever runs;
 *   2. clamps the limits and injects Mongo's `maxTimeMS`;
 *   3. exec's `sh -c <studioScript>` with the statement in env — the script
 *      resolves credentials in-task from the recipe, so no value leaves the
 *      container;
 *   4. parses the client's output into a capped, WS-frame-safe result.
 *
 * Local veto: `SWARMY_ALLOW_STUDIO=false` refuses every studio query on this node.
 */
import { randomBytes } from 'node:crypto';
import type { DockerClient } from '@swarmy/core/docker';
import {
  MAX_MESSAGE_BYTES,
  STUDIO_ERROR,
  STUDIO_MAX,
  redisArgHints,
  type DbQueryPayload,
  type DbQueryResult,
} from '@swarmy/core/protocol';
import { REDIS_SCAN_LUA, classifyMongo, classifyRedis, classifySql, singleStatementText } from '@swarmy/core/studio';
import {
  MONGO_STUDIO_JS,
  documentsToGrid,
  parseMongoOutput,
  parseMysqlOutput,
  parsePsqlOutput,
  parseRedisNoRaw,
  redisReplyToGrid,
  splitStderr,
  studioScript,
} from '@swarmy/core/studio/scripts';
import { execCapture } from './exec';

const MONGO_TIMED = new Set(['find', 'aggregate', 'count', 'distinct', 'mapreduce', 'findandmodify']);
/** Leave room in the 1 MiB frame for the envelope + commandResult wrapper. */
const RESULT_BUDGET = MAX_MESSAGE_BYTES - 96 * 1024;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

async function localTask(docker: DockerClient, service: string): Promise<string | null> {
  const list = await docker.docker.listContainers({
    filters: { label: [`com.docker.swarm.service.name=${service}`], status: ['running'] },
  });
  return list[0]?.Id ?? null;
}

/** The second wall: refuse blocked statements always, and non-reads in read mode. */
export function checkOp(p: Pick<DbQueryPayload, 'engine' | 'op'>): void {
  const { op } = p;
  if (op.kind === 'sql') {
    if (p.engine !== 'postgres' && p.engine !== 'mysql' && p.engine !== 'mariadb') fail(STUDIO_ERROR.refused, `${p.engine} does not take SQL`);
    const c = classifySql(op.statement, p.engine === 'postgres' ? 'postgres' : 'mysql');
    if (c.blocked) fail(STUDIO_ERROR.refused, c.blocked);
    if (op.access === 'read' && c.class !== 'read') fail(STUDIO_ERROR.refused, `a ${c.class} statement cannot run read-only`);
    return;
  }
  if (op.kind === 'mongo') {
    if (p.engine !== 'mongo') fail(STUDIO_ERROR.refused, `${p.engine} does not take Mongo commands`);
    let doc: unknown;
    try {
      doc = JSON.parse(op.command);
    } catch {
      fail(STUDIO_ERROR.refused, 'the command is not a JSON document');
    }
    const c = classifyMongo(doc);
    if (c.blocked) fail(STUDIO_ERROR.refused, c.blocked);
    if (op.access === 'read' && c.class !== 'read') fail(STUDIO_ERROR.refused, `a ${c.class} command cannot run read-only`);
    return;
  }
  if (p.engine !== 'redis' && p.engine !== 'valkey') fail(STUDIO_ERROR.refused, `${p.engine} does not take Redis commands`);
  // The key browser's fixed read-only script is the one EVAL a read may run.
  if (op.argv[0]?.toUpperCase() === 'EVAL' && op.argv[1] === REDIS_SCAN_LUA && op.argv[2] === '0') return;
  const c = classifyRedis(op.argv);
  if (c.blocked) fail(STUDIO_ERROR.refused, c.blocked);
  if (op.access === 'read' && c.class !== 'read') fail(STUDIO_ERROR.refused, `a ${c.class} command cannot run read-only`);
}

/** Mongo: bound the server-side run time of commands that take `maxTimeMS`. */
export function withMaxTime(command: string, ms: number): string {
  const doc = JSON.parse(command) as Record<string, unknown>;
  const name = (Object.keys(doc)[0] ?? '').toLowerCase();
  if (MONGO_TIMED.has(name)) {
    const cur = Number(doc.maxTimeMS);
    doc.maxTimeMS = Number.isFinite(cur) && cur > 0 ? Math.min(cur, ms) : ms;
  }
  return JSON.stringify(doc);
}

/** Drop trailing rows until the serialized result fits the WS frame. */
export function fitFrame(r: DbQueryResult): DbQueryResult {
  let size = Buffer.byteLength(JSON.stringify(r), 'utf8');
  if (size <= RESULT_BUDGET) return r;
  const out = { ...r, rows: [...r.rows], documents: r.documents ? [...r.documents] : undefined, truncated: true };
  while (size > RESULT_BUDGET && out.rows.length > 0) {
    const drop = Math.max(1, Math.ceil(out.rows.length * 0.1));
    out.rows.splice(-drop);
    if (out.documents) out.documents.splice(-drop);
    size = Buffer.byteLength(JSON.stringify(out), 'utf8');
  }
  if (size > RESULT_BUDGET) out.reply = undefined;
  out.rowCount = out.rows.length;
  return out;
}

function queryError(stderrText: string, stdout: string, rc: number | null): string {
  const text = (stderrText || stdout).trim().split('\n').filter((l) => !/^mysql: \[Warning\]/.test(l)).join('\n');
  return text.slice(-1500) || `the client exited ${rc ?? '?'}`;
}

export async function dbQuery(docker: DockerClient, p: DbQueryPayload): Promise<DbQueryResult> {
  const started = Date.now();
  if (process.env.SWARMY_ALLOW_STUDIO === 'false') fail(STUDIO_ERROR.refused, 'the database studio is disabled on this node (SWARMY_ALLOW_STUDIO=false)');
  checkOp(p);
  const limits = {
    statementTimeoutMs: Math.min(p.limits.statementTimeoutMs, STUDIO_MAX.statementTimeoutMs),
    rowCap: Math.min(p.limits.rowCap, STUDIO_MAX.rowCap),
    maxBytes: Math.min(p.limits.maxBytes, STUDIO_MAX.maxBytes),
  };
  const containerId = await localTask(docker, p.service);
  if (!containerId) fail(STUDIO_ERROR.noTask, `no running task of ${p.service} on this node`);

  const env: string[] = [
    `SWARMY_ACCESS=${p.op.access}`,
    `SWARMY_TIMEOUT_MS=${limits.statementTimeoutMs}`,
    `SWARMY_MAX_BYTES=${limits.maxBytes}`,
    `SWARMY_ROW_CAP=${limits.rowCap}`,
  ];
  if (p.database) env.push(`SWARMY_Q_DB=${p.database}`);
  if (p.dbIndex != null) env.push(`SWARMY_Q_DBINDEX=${p.dbIndex}`);
  if (p.creds.password.some((s) => s.kind === 'redis-cmdline')) {
    const info = await docker.docker.getContainer(containerId).inspect();
    const hints = redisArgHints([...(info.Config?.Entrypoint ?? []), ...(info.Config?.Cmd ?? [])]);
    if (hints.password) env.push(`SWARMY_REDIS_ARGPW=${hints.password}`);
    if (hints.conf) env.push(`SWARMY_REDIS_CONF=${hints.conf}`);
  }
  const nullSentinel = `__swarmy_null_${randomBytes(8).toString('hex')}__`;
  const cmd = ['sh', '-c', studioScript(p.engine, p.creds), 'swarmy-studio'];
  if (p.op.kind === 'sql') {
    const text = singleStatementText(p.op.statement, p.engine === 'postgres' ? 'postgres' : 'mysql');
    if (!text) fail(STUDIO_ERROR.refused, 'run one statement at a time');
    env.push(`SWARMY_Q=${text}`, `SWARMY_NULL=${nullSentinel}`);
  } else if (p.op.kind === 'mongo') {
    env.push(`SWARMY_Q=${withMaxTime(p.op.command, limits.statementTimeoutMs)}`, `SWARMY_JS=${MONGO_STUDIO_JS}`);
  } else {
    cmd.push(...p.op.argv);
  }

  let res;
  try {
    res = await execCapture(docker, containerId, { cmd, env, timeoutMs: limits.statementTimeoutMs + 20_000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timed out/.test(msg)) fail(STUDIO_ERROR.timeout, `the query ran past ${Math.round(limits.statementTimeoutMs / 1000)}s`);
    throw e;
  }
  const { rc, text: errText } = splitStderr(res.stderr);
  if (res.exitCode === 3) fail(STUDIO_ERROR.noClient, errText.replace(/^swarmy: /, '') || 'no client in this image');
  const base = { engine: p.engine, notices: [] as string[], durationMs: 0 };

  let result: DbQueryResult;
  if (p.op.kind === 'sql') {
    // psql cut by the byte cap exits 141 (SIGPIPE) — that is truncation, not failure.
    const cut = Buffer.byteLength(res.stdout, 'utf8') > limits.maxBytes;
    if (rc !== 0 && !(cut && (rc === 141 || rc === 1 && !errText))) {
      if (rc === 137 || /statement timeout|max_execution_time|max_statement_time|maximum statement execution time|query execution was interrupted/i.test(errText)) {
        fail(STUDIO_ERROR.timeout, `the query ran past ${Math.round(limits.statementTimeoutMs / 1000)}s`);
      }
      fail(STUDIO_ERROR.query, queryError(errText, res.stdout, rc));
    }
    const parse = p.engine === 'postgres' ? (s: string, o: Parameters<typeof parseMysqlOutput>[1]) => parsePsqlOutput(s, nullSentinel, o) : parseMysqlOutput;
    const parsed = parse(res.stdout, { rowCap: limits.rowCap, maxBytes: limits.maxBytes, access: p.op.access });
    result = {
      ...base,
      columns: parsed.columns,
      rows: parsed.rows,
      rowCount: parsed.rows.length,
      truncated: parsed.truncated,
      ...(parsed.affected != null ? { affected: parsed.affected } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
      notices: errText ? errText.split('\n').filter((l) => /NOTICE|WARNING|Warning/.test(l)).slice(0, 20) : [],
    };
  } else if (p.op.kind === 'mongo') {
    let parsed;
    try {
      parsed = parseMongoOutput(res.stdout);
    } catch {
      if (rc === 137) fail(STUDIO_ERROR.timeout, `the command ran past ${Math.round(limits.statementTimeoutMs / 1000)}s`);
      fail(STUDIO_ERROR.query, queryError(errText, res.stdout, rc));
    }
    if (!parsed.ok) {
      if (/time limit|MaxTimeMSExpired|exceeded time limit/i.test(parsed.error ?? '')) fail(STUDIO_ERROR.timeout, `the command ran past ${Math.round(limits.statementTimeoutMs / 1000)}s`);
      fail(STUDIO_ERROR.query, parsed.error ?? 'command failed');
    }
    const docs = parsed.docs ?? [];
    const grid = parsed.docs ? documentsToGrid(docs) : documentsToGrid([parsed.reply]);
    const reply = parsed.reply as Record<string, unknown> | null;
    const n = reply && typeof reply.n === 'number' ? reply.n : undefined;
    result = {
      ...base,
      columns: grid.columns,
      rows: grid.rows,
      rowCount: grid.rows.length,
      truncated: parsed.truncated,
      documents: parsed.docs ?? [parsed.reply],
      reply: parsed.reply,
      ...(n != null && p.op.access === 'write' ? { affected: n } : {}),
    };
  } else {
    if (rc !== 0 && rc !== 141) {
      if (rc === 137) fail(STUDIO_ERROR.timeout, `the command ran past ${Math.round(limits.statementTimeoutMs / 1000)}s`);
      fail(STUDIO_ERROR.query, queryError(errText, res.stdout, rc));
    }
    const cut = Buffer.byteLength(res.stdout, 'utf8') > limits.maxBytes;
    let reply;
    try {
      reply = parseRedisNoRaw(cut ? res.stdout.slice(0, res.stdout.lastIndexOf('\n') + 1) : res.stdout);
    } catch {
      fail(STUDIO_ERROR.query, 'could not read the reply');
    }
    if (reply && typeof reply === 'object' && !Array.isArray(reply) && 'error' in reply) fail(STUDIO_ERROR.query, reply.error);
    if (/NOAUTH|WRONGPASS/.test(res.stdout + errText)) fail(STUDIO_ERROR.query, 'the server refused the credentials');
    const grid = redisReplyToGrid(p.op.argv, reply);
    const capped = grid.rows.length > limits.rowCap;
    result = {
      ...base,
      columns: grid.columns,
      rows: capped ? grid.rows.slice(0, limits.rowCap) : grid.rows,
      rowCount: Math.min(grid.rows.length, limits.rowCap),
      truncated: cut || capped,
      reply,
      ...(typeof reply === 'number' && p.op.access === 'write' ? { affected: reply } : {}),
      ...(reply && typeof reply === 'object' && 'status' in reply ? { status: String(reply.status) } : {}),
    };
  }
  result.durationMs = Date.now() - started;
  return fitFrame(result);
}
