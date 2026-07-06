import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentPackaging, selfReplaceAt } from './update';

// A stand-in "binary" that survives the --version sanity probe.
const FAKE_NEW_BINARY = '#!/bin/sh\necho "swarmy-agent 9.9.9 (protocol 1, commit test)"\n';
// One that starts but does not identify as the agent.
const IMPOSTER_BINARY = '#!/bin/sh\necho "definitely-not-the-agent"\n';

const CMD_ID = '00000000-0000-4000-8000-000000000003';

let dirs: string[] = [];
let servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const s of servers) s.stop(true);
  dirs = [];
  servers = [];
});

function sandbox(): { binPath: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-update-'));
  dirs.push(dir);
  const binPath = path.join(dir, 'swarmy-agent');
  writeFileSync(binPath, '#!/bin/sh\necho "swarmy-agent 0.1.0 (old)"\n');
  chmodSync(binPath, 0o755);
  return { binPath, dir };
}

function serve(body: string): string {
  const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
  servers.push(server);
  return `http://localhost:${server.port}/swarmy-agent-test`;
}

function sha256(body: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(body);
  return hasher.digest('hex');
}

function payload(downloadUrl: string, sha: string) {
  return {
    commandId: CMD_ID,
    targetVersion: '9.9.9',
    downloadUrl,
    sha256: sha,
    strategy: 'self-replace' as const,
  };
}

describe('selfReplaceAt', () => {
  test('swaps the binary and keeps the old one for rollback', async () => {
    const { binPath } = sandbox();
    await selfReplaceAt(payload(serve(FAKE_NEW_BINARY), sha256(FAKE_NEW_BINARY)), binPath);

    expect(readFileSync(binPath, 'utf8')).toBe(FAKE_NEW_BINARY);
    expect(readFileSync(`${binPath}.old`, 'utf8')).toContain('0.1.0');
    expect(existsSync(`${binPath}.download`)).toBe(false);
  });

  test('a checksum mismatch leaves the running binary untouched and removes the download', async () => {
    const { binPath } = sandbox();
    const before = readFileSync(binPath, 'utf8');
    await expect(
      selfReplaceAt(payload(serve(FAKE_NEW_BINARY), 'b'.repeat(64)), binPath),
    ).rejects.toThrow(/checksum mismatch/);

    expect(readFileSync(binPath, 'utf8')).toBe(before);
    expect(existsSync(`${binPath}.download`)).toBe(false);
    expect(existsSync(`${binPath}.old`)).toBe(false);
  });

  test('a binary that fails the --version sanity probe is rejected', async () => {
    const { binPath } = sandbox();
    const before = readFileSync(binPath, 'utf8');
    await expect(
      selfReplaceAt(payload(serve(IMPOSTER_BINARY), sha256(IMPOSTER_BINARY)), binPath),
    ).rejects.toThrow(/sanity check/);

    expect(readFileSync(binPath, 'utf8')).toBe(before);
    expect(existsSync(`${binPath}.download`)).toBe(false);
  });

  test('requires downloadUrl + sha256', async () => {
    const { binPath } = sandbox();
    await expect(
      selfReplaceAt(
        { commandId: CMD_ID, targetVersion: '9.9.9', strategy: 'self-replace' as const },
        binPath,
      ),
    ).rejects.toThrow(/requires downloadUrl/);
  });
});

describe('agentPackaging', () => {
  test('reports container when running interpreted (as tests do)', () => {
    expect(agentPackaging()).toBe('container');
  });
});
