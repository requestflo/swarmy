import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, openSqlite, type TestDb } from '@swarmy/db';
import { installSnapshotFile, isSqliteFile, loadControlPlane, snapshotControlPlane } from './controllerBackup.snapshot';

// Real SQLite stores: the snapshot is a VACUUM INTO file, restored two ways.
let src: TestDb;
let dst: TestDb;
const scratch = mkdtempSync(join(tmpdir(), 'swarmy-snapshot-test-'));

beforeAll(async () => {
  src = await createTestDb();
  dst = await createTestDb();
  await src.db.organization.create({ data: { id: 'org_1', name: 'Acme', slug: 'acme' } });
  await src.db.auditLog.create({ data: { orgId: 'org_1', action: 'a', metadata: { k: [1, 2] } } });
  await src.db.auditLog.create({ data: { orgId: 'org_1', action: 'b' } });
});
afterAll(async () => {
  await src.close();
  await dst.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('controller snapshot', () => {
  it('VACUUM INTO produces a complete SQLite file while the store stays open', async () => {
    const bytes = await snapshotControlPlane(src.db);
    expect(isSqliteFile(bytes)).toBe(true);
    const file = join(scratch, 'peek.db');
    writeFileSync(file, bytes);
    const peek = openSqlite(file, {});
    expect(peek.query('SELECT count(*) AS n FROM audit_log').get()).toEqual({ n: 2n });
    peek.close();
    // The live store is untouched and still writable.
    await src.db.auditLog.create({ data: { orgId: 'org_1', action: 'after' } });
    expect(await src.db.auditLog.count()).toBe(3);
  });

  it('in-place restore replaces every table with the snapshot rows', async () => {
    const bytes = await snapshotControlPlane(src.db);
    // Pre-existing rows in the target are replaced, not merged.
    await dst.db.organization.create({ data: { id: 'org_stale', name: 'Old', slug: 'old' } });
    const tables = await loadControlPlane(dst.db, bytes);
    expect(tables).toContain('organization');
    expect(tables).not.toContain('_swarmy_migrations');
    expect((await dst.db.organization.findMany()).map((o) => o.id)).toEqual(['org_1']);
    const logs = await dst.db.auditLog.findMany({ orderBy: { id: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['a', 'b', 'after']);
    expect(logs[0]!.metadata).toEqual({ k: [1, 2] });
    // Foreign keys are back on afterwards.
    await expect(
      Promise.resolve(dst.db.auditLog.create({ data: { orgId: 'org_missing', action: 'x' } })),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('refuses bytes that are not a SQLite file', async () => {
    await expect(loadControlPlane(dst.db, Buffer.from('INSERT INTO organization …'))).rejects.toThrow(/not a SQLite/);
  });

  it('disaster restore puts the file in place and keeps the previous one beside it', async () => {
    const bytes = await snapshotControlPlane(src.db);
    const dir = join(scratch, 'data');
    mkdirSync(join(dir, '.control.db-litestream'), { recursive: true });
    const path = join(dir, 'control.db');
    writeFileSync(path, 'old');
    writeFileSync(`${path}-wal`, 'old-wal');
    const { keptAs } = await installSnapshotFile(bytes, path);
    expect(keptAs).toBeDefined();
    expect(readFileSync(keptAs!, 'utf8')).toBe('old');
    expect(readFileSync(`${keptAs!}-wal`, 'utf8')).toBe('old-wal');
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(join(dir, '.control.db-litestream'))).toBe(false);
    const db = openSqlite(path, {});
    expect(db.query('SELECT slug FROM organization').get()).toEqual({ slug: 'acme' });
    db.close();
  });
});
