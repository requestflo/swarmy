/**
 * A fresh, migrated SQLite store for tests: one temp dir per call, both files
 * migrated through the same `ensureSchema()` path the controller boots with.
 *
 *   const t = await createTestDb();
 *   … t.db.user.create(…) …
 *   await t.close();
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from './bun-sqlite-adapter';
import { ensureSchema, TELEMETRY_MIGRATIONS_DIR } from './ensure-schema';
import { PrismaClient } from './generated/client';
import { PrismaClient as TelemetryClient } from './generated-telemetry/client';
import type { DB, TelemetryDB } from './client';

export interface TestDb {
  db: DB;
  telemetry: TelemetryDB;
  dir: string;
  controlPath: string;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), 'swarmy-db-test-'));
  const controlPath = join(dir, 'control.db');
  const control = new PrismaBunSqlite({ url: controlPath });
  const tel = new PrismaBunSqlite({ url: join(dir, 'telemetry.db') });
  await ensureSchema(control);
  await ensureSchema(tel, TELEMETRY_MIGRATIONS_DIR);
  const db = new PrismaClient({ adapter: control }) as DB;
  const telemetry = new TelemetryClient({ adapter: tel }) as TelemetryDB;
  return {
    db,
    telemetry,
    dir,
    controlPath,
    async close() {
      await db.$disconnect();
      await telemetry.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
