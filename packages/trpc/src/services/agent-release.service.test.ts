import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentBinaryPath,
  agentRelease,
  platformForArch,
  resetAgentReleaseCache,
} from './agent-release.service';

const ORIGINAL_DIR = process.env.SWARMY_AGENT_BIN_DIR;

afterEach(() => {
  if (ORIGINAL_DIR === undefined) delete process.env.SWARMY_AGENT_BIN_DIR;
  else process.env.SWARMY_AGENT_BIN_DIR = ORIGINAL_DIR;
  resetAgentReleaseCache();
});

function makeBinDir(manifest: unknown, binaries: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-bin-'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const name of binaries) writeFileSync(path.join(dir, name), 'ELF');
  process.env.SWARMY_AGENT_BIN_DIR = dir;
  resetAgentReleaseCache();
  return dir;
}

describe('agentRelease', () => {
  test('loads a valid manifest', () => {
    makeBinDir({ version: '1.2.3', platforms: { 'linux-x64': { sha256: 'a'.repeat(64), size: 1 } } });
    expect(agentRelease()?.version).toBe('1.2.3');
    expect(Object.keys(agentRelease()?.platforms ?? {})).toEqual(['linux-x64']);
  });

  test('returns null for a missing or malformed manifest', () => {
    process.env.SWARMY_AGENT_BIN_DIR = mkdtempSync(path.join(tmpdir(), 'agent-bin-empty-'));
    resetAgentReleaseCache();
    expect(agentRelease()).toBeNull();

    makeBinDir('not-an-object');
    expect(agentRelease()).toBeNull();
  });
});

describe('agentBinaryPath', () => {
  test('resolves only existing released binaries', () => {
    const dir = makeBinDir(
      {
        version: '1.2.3',
        platforms: {
          'linux-x64': { sha256: 'a'.repeat(64), size: 1 },
          'linux-arm64': { sha256: 'b'.repeat(64), size: 1 },
        },
      },
      ['swarmy-agent-linux-x64'],
    );
    expect(agentBinaryPath('linux-x64')).toBe(path.join(dir, 'swarmy-agent-linux-x64'));
    // in the manifest but the file is missing → null, never a broken download
    expect(agentBinaryPath('linux-arm64')).toBeNull();
    expect(agentBinaryPath('windows-x64')).toBeNull();
  });

  test('rejects path-traversal platform keys', () => {
    makeBinDir({
      version: '1.2.3',
      platforms: { '../../etc/passwd': { sha256: 'a'.repeat(64), size: 1 } },
    });
    expect(agentBinaryPath('../../etc/passwd')).toBeNull();
  });
});

describe('platformForArch', () => {
  test('maps Docker/uname arches to binary platforms', () => {
    expect(platformForArch('x86_64')).toBe('linux-x64');
    expect(platformForArch('amd64')).toBe('linux-x64');
    expect(platformForArch('aarch64')).toBe('linux-arm64');
    expect(platformForArch('arm64')).toBe('linux-arm64');
    expect(platformForArch('riscv64')).toBeNull();
    expect(platformForArch(null)).toBeNull();
  });
});
