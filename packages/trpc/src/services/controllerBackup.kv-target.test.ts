import { describe, expect, test } from 'bun:test';
import { SwarmKv, memoryKvDriver, plainKvSealer } from '@swarmy/core';
import { encryptSecret } from '@swarmy/core/crypto';
import { readRestoreTargetFromKv } from './controllerBackup.kv-target';
import { vaultSealer } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ||= 'kv-target-test-key';

const target = (name: string, bucket: string) => ({
  name,
  kind: 'S3',
  endpoint: 'https://s3.example.com',
  bucket,
  prefix: 'swarmy',
  region: 'eu-west-1',
  credentialRef: encryptSecret('AKIA123'),
  secretKeyRef: encryptSecret('s3cr3t'),
  resticPasswordRef: encryptSecret('restic-pw'),
  enabled: true,
});

async function swarm(sealer = plainKvSealer) {
  const driver = memoryKvDriver();
  const kv = new SwarmKv({ orgId: 'org1', driver, sealer });
  await kv.put('bkp-target', 't-offsite', target('offsite', 'ctl-backups'));
  await kv.put('bkp-target', 't-other', target('other', 'volumes'));
  await kv.put('ctl-backup', 'controller', { targetId: 't-offsite', enabled: true, schedule: '0 3 * * *' });
  return driver;
}

describe('the restore CLI reads where controller backups are from the swarm', () => {
  test('follows ctl-backup/controller to its destination and decrypts the credentials', async () => {
    const t = await readRestoreTargetFromKv(await swarm(), { sealer: plainKvSealer });
    expect(t).toEqual({
      orgId: 'org1',
      targetId: 't-offsite',
      name: 'offsite',
      kind: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'ctl-backups',
      prefix: 'swarmy',
      region: 'eu-west-1',
      accessKeyId: 'AKIA123',
      secretAccessKey: 's3cr3t',
      resticPassword: 'restic-pw',
    });
  });

  test('opens vault-sealed documents with SWARMY_SECRET_KEY (the controller’s own sealer)', async () => {
    const t = await readRestoreTargetFromKv(await swarm(vaultSealer));
    expect(t?.bucket).toBe('ctl-backups');
  });

  test('--target picks another destination by id or by name', async () => {
    const driver = await swarm();
    expect((await readRestoreTargetFromKv(driver, { target: 't-other', sealer: plainKvSealer }))?.bucket).toBe('volumes');
    expect((await readRestoreTargetFromKv(driver, { target: 'other', sealer: plainKvSealer }))?.targetId).toBe('t-other');
    await expect(readRestoreTargetFromKv(driver, { target: 'nope', sealer: plainKvSealer })).rejects.toThrow(/no backup destination "nope"/);
  });

  test('a swarm with no controller-backup config gives null (the flags decide)', async () => {
    expect(await readRestoreTargetFromKv(memoryKvDriver(), { sealer: plainKvSealer })).toBeNull();
  });

  test('a config pointing at a removed destination says so', async () => {
    const driver = memoryKvDriver();
    await new SwarmKv({ orgId: 'org1', driver, sealer: plainKvSealer }).put('ctl-backup', 'controller', { targetId: 'gone' });
    await expect(readRestoreTargetFromKv(driver, { sealer: plainKvSealer })).rejects.toThrow(/destination gone/);
  });
});
