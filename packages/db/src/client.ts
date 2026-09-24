import { dirname, isAbsolute, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from './generated/client';
import { PrismaClient as TelemetryClient } from './generated-telemetry/client';
import { PrismaBunSqlite } from './bun-sqlite-adapter';

/**
 * The controller's store: two embedded SQLite files on the controller volume.
 *
 *   control.db    identity, access, audit, history, outboxes, config — every
 *                 model in prisma/schema.
 *   telemetry.db  MetricSample only (prisma/telemetry). High-churn, rebuildable,
 *                 kept apart so it never bloats the control-plane file, its
 *                 backups, or its replica.
 *
 * Paths: `SWARMY_DB_PATH` / `SWARMY_TELEMETRY_DB_PATH` if set, else
 * `${SWARMY_DATA_DIR}/control.db` and `${SWARMY_DATA_DIR}/telemetry.db`. In
 * production SWARMY_DATA_DIR is /var/lib/swarmy/data on the `swarmy-data`
 * volume. With nothing set (local dev) the files live in `<repo>/.swarmy/data`.
 * `:memory:` works for either path (tests).
 *
 * Every connection gets journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON
 * and busy_timeout=5000 (see bun-sqlite-adapter.ts).
 */
export interface DbPaths {
  control: string;
  telemetry: string;
}

const here = dirname(fileURLToPath(import.meta.url));
/** `<repo>/.swarmy/data` — the dev default (gitignored). */
export const DEV_DATA_DIR = resolve(here, '..', '..', '..', '.swarmy', 'data');

export function resolveDbPaths(env: NodeJS.ProcessEnv = process.env): DbPaths {
  const dataDir = env.SWARMY_DATA_DIR?.trim() || DEV_DATA_DIR;
  const pick = (explicit: string | undefined, file: string): string => {
    const v = explicit?.trim().replace(/^file:(\/\/)?/, '');
    if (v) return v === ':memory:' || isAbsolute(v) ? v : resolve(v);
    return join(dataDir, file);
  };
  return {
    control: pick(env.SWARMY_DB_PATH, 'control.db'),
    telemetry: pick(env.SWARMY_TELEMETRY_DB_PATH, 'telemetry.db'),
  };
}

function ensureDir(path: string): void {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
}

/** One adapter factory (and so one SQLite handle) per file per process. */
const factories = new Map<string, PrismaBunSqlite>();

function factoryFor(path: string): PrismaBunSqlite {
  // In-memory databases are private per factory: sharing one would make every
  // caller see the same scratch DB by accident.
  if (path === ':memory:') return new PrismaBunSqlite({ url: path });
  let f = factories.get(path);
  if (!f) {
    ensureDir(path);
    f = new PrismaBunSqlite({ url: path });
    factories.set(path, f);
  }
  return f;
}

/** Adapter factory for control.db. Boot-time `ensureSchema()`, the restore CLI
 *  and the app's PrismaClient share it, so they share one handle. */
export function buildAdapter(env: NodeJS.ProcessEnv = process.env): PrismaBunSqlite {
  return factoryFor(resolveDbPaths(env).control);
}

/** Adapter factory for telemetry.db. */
export function buildTelemetryAdapter(env: NodeJS.ProcessEnv = process.env): PrismaBunSqlite {
  return factoryFor(resolveDbPaths(env).telemetry);
}

// Reuse a single client across hot reloads in dev (Bun --watch). Clients are
// built lazily on first property access, so importing `@swarmy/db` (e.g. in
// unit tests that mock the DB) never opens a file.
const globalForPrisma = globalThis as unknown as {
  __swarmyPrisma?: PrismaClient;
  __swarmyTelemetry?: TelemetryClient;
};

function lazy<T extends object>(make: () => T): T {
  let client: T | undefined;
  return new Proxy({} as T, {
    get(_t, prop, receiver) {
      client ??= make();
      return Reflect.get(client, prop, receiver);
    },
    has(_t, prop) {
      client ??= make();
      return prop in client;
    },
  });
}

export const prisma: PrismaClient = lazy(() => {
  if (globalForPrisma.__swarmyPrisma) return globalForPrisma.__swarmyPrisma;
  const client = new PrismaClient({ adapter: buildAdapter() });
  if (process.env.NODE_ENV !== 'production') globalForPrisma.__swarmyPrisma = client;
  return client;
});

export const telemetry: TelemetryClient = lazy(() => {
  if (globalForPrisma.__swarmyTelemetry) return globalForPrisma.__swarmyTelemetry;
  const client = new TelemetryClient({ adapter: buildTelemetryAdapter() });
  if (process.env.NODE_ENV !== 'production') globalForPrisma.__swarmyTelemetry = client;
  return client;
});

export type DB = typeof prisma;
export type TelemetryDB = typeof telemetry;
