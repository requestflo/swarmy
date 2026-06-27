import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';
import { PrismaPGlite } from './pglite-adapter';

/**
 * Adapter selector (data-store-strategy epic, P0).
 *
 * One Postgres dialect, one `schema.prisma`, one migration history — only the
 * *driver* changes by mode:
 *
 *   SWARMY_DB_DRIVER=postgres  (default)  → @prisma/adapter-pg over DATABASE_URL.
 *                                            Covers swarmy-managed Postgres and
 *                                            bring-your-own/external Postgres.
 *   SWARMY_DB_DRIVER=pglite               → embedded Postgres (WASM, in-process).
 *                                            File-backed at SWARMY_DATA_DIR, or
 *                                            in-memory if unset. Zero external
 *                                            dependencies — the "lite" default
 *                                            for getting-started / single-node.
 *
 * `postgres` stays the default for back-compat with the existing scaffold; new
 * single-binary installs set `SWARMY_DB_DRIVER=pglite`.
 */
export type DbDriver = 'pglite' | 'postgres';

/** Resolve the driver from env, inferring from the DATABASE_URL scheme. */
export function resolveDbDriver(env: NodeJS.ProcessEnv = process.env): DbDriver {
  const explicit = env.SWARMY_DB_DRIVER?.trim().toLowerCase();
  if (explicit === 'pglite' || explicit === 'postgres') return explicit;
  // Infer from the URL scheme when not explicitly set.
  const url = env.DATABASE_URL ?? '';
  if (url.startsWith('pglite:') || url.startsWith('file:') || url.startsWith('memory:')) {
    return 'pglite';
  }
  return 'postgres';
}

/**
 * Build the right Prisma driver-adapter factory for the active mode. Exported so
 * boot-time `ensureSchema()` / the restore CLI can construct a client the same
 * way the app does.
 */
export function buildAdapter(
  env: NodeJS.ProcessEnv = process.env,
): PrismaPg | PrismaPGlite {
  const driver = resolveDbDriver(env);
  if (driver === 'pglite') {
    // `file:/path` and `pglite:/path` URLs carry the data dir; else SWARMY_DATA_DIR.
    const fromUrl = (env.DATABASE_URL ?? '').replace(/^(pglite|file):\/\//, '').replace(/^(pglite|file):/, '');
    const dataDir = env.SWARMY_DATA_DIR ?? (fromUrl && !fromUrl.startsWith('memory') ? fromUrl : undefined);
    return new PrismaPGlite({ dataDir: dataDir || undefined });
  }
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set — required for SWARMY_DB_DRIVER=postgres (copy .env.example to .env), ' +
        'or set SWARMY_DB_DRIVER=pglite for embedded lite mode.',
    );
  }
  return new PrismaPg({ connectionString });
}

// Reuse a single client across hot reloads in dev (Bun --watch). The client is
// built lazily on first property access so merely importing `@swarmy/db` (e.g. in
// unit tests that only exercise the selector) never forces an adapter/env.
const globalForPrisma = globalThis as unknown as { __swarmyPrisma?: PrismaClient };

function makeClient(): PrismaClient {
  if (globalForPrisma.__swarmyPrisma) return globalForPrisma.__swarmyPrisma;
  const client = new PrismaClient({ adapter: buildAdapter() });
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.__swarmyPrisma = client;
  }
  return client;
}

let _client: PrismaClient | undefined;
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop, receiver) {
    _client ??= makeClient();
    return Reflect.get(_client as object, prop, receiver);
  },
  has(_t, prop) {
    _client ??= makeClient();
    return prop in (_client as object);
  },
}) as PrismaClient;

export type DB = typeof prisma;
