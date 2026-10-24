import { describe, expect, test } from 'bun:test';
import { SwarmKv, memoryKvDriver } from '@swarmy/core';
import { encryptSecret } from '@swarmy/core/crypto';
import { kvVaultSealer as vaultSealer, type KvRestoreTarget } from '@swarmy/trpc';
import { buildRepo, parseArgs } from './restore-args';
import { targetFromSwarm } from './restore-swarm';

process.env.SWARMY_SECRET_KEY ||= 'restore-args-test-key';

const KV: KvRestoreTarget = {
  orgId: 'org1',
  targetId: 't1',
  name: 'offsite',
  kind: 's3',
  endpoint: 'https://s3.example.com',
  bucket: 'ctl',
  prefix: 'swarmy',
  region: 'eu-west-1',
  accessKeyId: 'AKIA',
  secretAccessKey: 'sk',
  resticPassword: 'pw',
};

describe('restore CLI: the target from the swarm, flags as overrides', () => {
  test('the swarm alone is a whole target', () => {
    const { repo, overridden } = buildRepo({}, KV, {});
    expect(repo).toEqual({
      kind: 's3',
      repo: 's3:https://s3.example.com/ctl/swarmy',
      password: 'pw',
      endpoint: 'https://s3.example.com',
      region: 'eu-west-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'sk',
    });
    expect(overridden).toEqual([]);
  });

  test('each flag (or env alias) overrides just its field, and is named', () => {
    const flags = parseArgs(['--endpoint', 'https://mirror.example.com', '--prefix', 'dr']);
    const { repo, overridden } = buildRepo(flags, KV, { RESTIC_PASSWORD: 'other-pw' });
    expect(repo.repo).toBe('s3:https://mirror.example.com/ctl/dr');
    expect(repo.password).toBe('other-pw');
    expect(repo.accessKeyId).toBe('AKIA');
    expect(overridden).toEqual(['endpoint', 'prefix', 'restic-password']);
  });

  test('with nothing in the swarm the flags are the target, as before', () => {
    const flags = parseArgs(['--target-kind', 'node', '--bucket', '/srv/backups/', '--restic-password', 'x']);
    expect(buildRepo(flags, null, {}).repo.repo).toBe('/srv/backups');
    expect(() => buildRepo({}, null, {})).toThrow(/--bucket is required/);
    expect(() => buildRepo(parseArgs(['--bucket', 'b']), null, {})).toThrow(/--restic-password/);
  });
});

describe('restore CLI: reading the swarm', () => {
  async function swarm() {
    const driver = memoryKvDriver();
    const kv = new SwarmKv({ orgId: 'org1', driver, sealer: vaultSealer });
    await kv.put('bkp-target', 't1', {
      name: 'offsite', kind: 'S3', endpoint: 'https://s3.example.com', bucket: 'ctl', prefix: null, region: null,
      credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('pw'), enabled: true,
    });
    await kv.put('ctl-backup', 'controller', { targetId: 't1', enabled: true });
    return driver;
  }

  test('reads the configured destination through the manager’s Docker socket', async () => {
    const lines: string[] = [];
    const driver = await swarm();
    const t = await targetFromSwarm({}, (l) => lines.push(l), { driver: () => driver, env: process.env });
    expect(t?.resticPassword).toBe('pw');
    expect(lines).toEqual(['backup destination from the swarm: "offsite" (https://s3.example.com/ctl)']);
  });

  test('falls back to the flags, saying why, when the swarm can’t be read', async () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    const broken = () => ({ ...memoryKvDriver(), list: async () => { throw new Error('connect ENOENT /var/run/docker.sock'); } });
    expect(await targetFromSwarm({}, log, { driver: broken, env: process.env })).toBeNull();
    expect(await targetFromSwarm({}, log, { driver: broken, env: {} })).toBeNull();
    expect(await targetFromSwarm({ 'no-swarm-kv': true }, log, { driver: broken })).toBeNull();
    expect(lines[0]).toContain('ENOENT');
    expect(lines[1]).toContain('SWARMY_SECRET_KEY is not set');
    expect(lines[2]).toContain('--no-swarm-kv');
  });

  test('--target never falls back to a guess', async () => {
    const driver = await swarm();
    await expect(targetFromSwarm({ target: 'nope' }, () => {}, { driver: () => driver, env: process.env })).rejects.toThrow(/no backup destination/);
    await expect(targetFromSwarm({ target: 'offsite' }, () => {}, { driver: () => driver, env: {} })).rejects.toThrow(/SWARMY_SECRET_KEY/);
  });
});
