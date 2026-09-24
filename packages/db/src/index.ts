export { prisma, telemetry, buildAdapter, buildTelemetryAdapter, resolveDbPaths, DEV_DATA_DIR } from './client';
export type { DB, TelemetryDB, DbPaths } from './client';
export { PrismaBunSqlite, BunSqliteAdapter, openSqlite, DEFAULT_PRAGMAS } from './bun-sqlite-adapter';
export type { BunSqliteOptions } from './bun-sqlite-adapter';
export { ensureSchema, CONTROL_MIGRATIONS_DIR, TELEMETRY_MIGRATIONS_DIR } from './ensure-schema';
export { createTestDb } from './testing';
export type { TestDb } from './testing';

// Re-export generated client values (enums) + types (Prisma namespace, models).
export * from './generated/client';
