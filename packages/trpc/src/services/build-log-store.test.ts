import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLogBus } from './build-log-bus';
import { decodeLog, encodeLog, localLogPath, persistBuildLog, readStoredBuildLog } from './build-log-store';

/** QA-056: a finished build's log survives the in-memory bus (a controller restart). */
const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-buildlogs-'));
process.env.SWARMY_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// No object storage in this double: the store degrades to the local file.
const ctx = { activeOrgId: 'o', hub: { liveInventory: () => ({ services: [], containers: [] }) }, db: {} } as never;

describe('durable build logs', () => {
  it('NDJSON round-trips and tolerates a torn line', () => {
    const lines = [
      { seq: 1, stream: 'stdout' as const, message: '#1 [internal] load build definition' },
      { seq: 2, stream: 'stderr' as const, message: 'npm WARN deprecated' },
    ];
    expect(decodeLog(encodeLog(lines))).toEqual(lines);
    expect(decodeLog(encodeLog(lines) + '{"seq":3,"str')).toEqual(lines);
  });

  it('persisted at finish, read back once the bus is gone (restart)', async () => {
    const ref = 'cmd-build-1';
    buildLogBus.push(ref, { seq: 1, stream: 'stdout', ts: 0, message: 'step 1/3' });
    buildLogBus.push(ref, { seq: 2, stream: 'stdout', ts: 0, message: 'SWARMY_DIGEST=sha256:2b40' }, true);
    expect(await persistBuildLog(ctx, ref)).toEqual({ local: true, object: false });
    expect(localLogPath(ref)).toBe(path.join(dir, 'build-logs', `${ref}.ndjson`));
    // A fresh process: nothing in memory for a different ref reader, the file answers.
    expect((await readStoredBuildLog(ctx, ref)).map((l) => l.message)).toEqual(['step 1/3', 'SWARMY_DIGEST=sha256:2b40']);
  });

  it('refuses unsafe refs and reads [] for a log never stored', async () => {
    expect(localLogPath('../../etc/passwd')).toBeNull();
    expect(await readStoredBuildLog(ctx, 'never-built')).toEqual([]);
    expect(await persistBuildLog(ctx, '../x')).toEqual({ local: false, object: false });
  });
});
