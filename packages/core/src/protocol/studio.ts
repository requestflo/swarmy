/**
 * Database studio — the `dbQuery` agent command (CommandName `db.query`).
 *
 * The controller never connects to a database and nothing is published. It
 * dispatches ONE bounded operation to the node running the DB task; the agent
 * runs the engine's own client (psql / mysql / mariadb / mongosh / redis-cli,
 * which the DB image ships) via a non-interactive exec INSIDE that task, so it
 * talks to 127.0.0.1 in the task's own network namespace.
 *
 * Credentials: the payload carries the same RECIPE the compose-DB dump path
 * uses (`AppDbCreds`: env / `_FILE` / literal / redis `--requirepass` names,
 * never values). The exec'd script resolves them in-task; no credential
 * crosses the WS, touches node disk, or appears in argv.
 *
 * Limits (agent-enforced, clamped to the hard maxima below whatever the
 * controller asks): a server-side statement timeout plus an outer kill, a row
 * cap, and an output byte cap. Access `read` runs inside a read-only
 * transaction where the engine has one (Postgres, MySQL/MariaDB); Mongo and
 * Redis enforce `read` with a command allowlist (they have no read-only
 * session). The controller classifies and gates every statement before it
 * dispatches (`@swarmy/core/studio`); the agent re-checks the allowlists.
 *
 * Subpath: `@swarmy/core/protocol`.
 */
import { z } from 'zod';
import { CommandId } from './primitives';
import { AppDbCreds } from './appDb';

/** Engines the studio speaks. `postgres` covers managed clusters and compose Postgres. */
export const StudioEngine = z.enum(['postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'valkey']);
export type StudioEngine = z.infer<typeof StudioEngine>;

export const StudioAccess = z.enum(['read', 'write']);
export type StudioAccess = z.infer<typeof StudioAccess>;

/** Defaults the controller applies; the agent clamps to the MAX_* ceilings. */
export const STUDIO_DEFAULTS = {
  statementTimeoutMs: 15_000,
  rowCap: 1_000,
  /** Raw client output kept per query (the WS frame cap is 1 MiB). */
  maxBytes: 512 * 1024,
} as const;
export const STUDIO_MAX = {
  statementTimeoutMs: 120_000,
  rowCap: 10_000,
  maxBytes: 768 * 1024,
  /** A statement / command document is at most this long (it rides exec env). */
  statementBytes: 64 * 1024,
} as const;

export const StudioLimits = z.object({
  statementTimeoutMs: z.number().int().positive().max(STUDIO_MAX.statementTimeoutMs).default(STUDIO_DEFAULTS.statementTimeoutMs),
  rowCap: z.number().int().positive().max(STUDIO_MAX.rowCap).default(STUDIO_DEFAULTS.rowCap),
  maxBytes: z.number().int().positive().max(STUDIO_MAX.maxBytes).default(STUDIO_DEFAULTS.maxBytes),
});
export type StudioLimits = z.infer<typeof StudioLimits>;

const Statement = z.string().min(1).max(STUDIO_MAX.statementBytes);

/** Identifier-ish database name (SQL database, Mongo db). Redis uses `dbIndex`. */
export const StudioDatabase = z.string().regex(/^[A-Za-z0-9_.$-]{1,128}$/, 'invalid database name');

/** One bounded operation. */
export const StudioOp = z.discriminatedUnion('kind', [
  /** A single SQL statement (Postgres / MySQL / MariaDB). */
  z.object({ kind: z.literal('sql'), statement: Statement, access: StudioAccess }),
  /** One Mongo command document (EJSON text) run with `runCommand`. */
  z.object({ kind: z.literal('mongo'), command: Statement, access: StudioAccess }),
  /** One Redis/Valkey command as argv. */
  z.object({
    kind: z.literal('redis'),
    argv: z.array(z.string().max(STUDIO_MAX.statementBytes)).min(1).max(1024),
    access: StudioAccess,
  }),
]);
export type StudioOp = z.infer<typeof StudioOp>;

export const DbQueryPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  engine: StudioEngine,
  /** Swarm service name; the agent finds its running task on THIS node. */
  service: z.string().min(1),
  creds: AppDbCreds,
  /** SQL / Mongo database to run in (absent = the recipe's database, else the engine default). */
  database: StudioDatabase.optional(),
  /** Redis/Valkey logical database. */
  dbIndex: z.number().int().min(0).max(255).optional(),
  op: StudioOp,
  limits: StudioLimits.default({}),
});
export type DbQueryPayload = z.infer<typeof DbQueryPayload>;
export const DbQueryMsg = z.object({ type: z.literal('dbQuery'), payload: DbQueryPayload });
export type DbQueryMsg = z.infer<typeof DbQueryMsg>;

/** A JSON-safe cell: SQL values are strings (or null); Mongo/Redis values are JSON. */
export const StudioCell = z.unknown();

export const DbQueryResult = z.object({
  engine: StudioEngine,
  /** Result columns in server order (SQL), first-seen field order (Mongo), synthetic (Redis). */
  columns: z.array(z.string()).default([]),
  rows: z.array(z.array(StudioCell)).default([]),
  /** Rows returned (after the cap). */
  rowCount: z.number().int().nonnegative().default(0),
  /** More rows / bytes existed than the caps allowed. */
  truncated: z.boolean().default(false),
  /** Rows a write touched (SQL command tag / ROW_COUNT, Mongo `n`), when known. */
  affected: z.number().int().optional(),
  /** Command tag or status line (`UPDATE 3`, `OK`). */
  status: z.string().optional(),
  /** Mongo: the raw reply (relaxed EJSON) — for JSON view and export. */
  documents: z.array(z.unknown()).optional(),
  /** Redis/Valkey: the parsed reply. */
  reply: z.unknown().optional(),
  /** Server notices / warnings (stderr that was not an error). */
  notices: z.array(z.string()).default([]),
  durationMs: z.number().int().nonnegative(),
});
export type DbQueryResult = z.infer<typeof DbQueryResult>;

/** Stable error codes the agent raises (in `commandResult.error.message` prefix). */
export const STUDIO_ERROR = {
  noTask: 'E_STUDIO_NO_TASK',
  noClient: 'E_STUDIO_NO_CLIENT',
  timeout: 'E_STUDIO_TIMEOUT',
  refused: 'E_STUDIO_REFUSED',
  query: 'E_STUDIO_QUERY',
} as const;
