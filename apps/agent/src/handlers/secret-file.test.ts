import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { singleFileTar } from './secret-file';

describe('singleFileTar', () => {
  test('is a tar that the system tar extracts to a 0600 file with the exact bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmy-tar-'));
    writeFileSync(join(dir, 'x.tar'), singleFileTar('setup-key', 'ABCD-1234\n'));
    const r = Bun.spawnSync(['tar', '-xf', 'x.tar'], { cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'setup-key'), 'utf8')).toBe('ABCD-1234\n');
    expect(statSync(join(dir, 'setup-key')).mode & 0o777).toBe(0o600);
  }, 30_000);
  test('blocks are 512-aligned', () => {
    expect(singleFileTar('k', 'x'.repeat(700)).length % 512).toBe(0);
  });
});
