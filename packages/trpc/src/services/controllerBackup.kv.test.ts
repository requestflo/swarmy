/**
 * The controller bundle carries the swarm-kv documents, so a restore onto a
 * FRESH swarm gets back the infra config that lives in the swarm.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentHub } from '../hub/types';
import { deserializeBundle, serializeBundle, SWARM_KV_MEMBER, type BundleContents } from './controllerBackup.bundle';
import { ingressConfigRepo } from './ingress-config.repo';
import {
  exportKvForBundle,
  importPendingKv,
  isKvRestorePending,
  kvFor,
  stashPendingKv,
  useMemoryKv,
} from './swarm-kv.service';

const base: BundleContents = {
  manifest: {
    swarmyVersion: '1',
    schemaVersion: '1',
    dbDriver: 'sqlite',
    createdAt: new Date(0).toISOString(),
    orgCount: 1,
    nodeCount: 1,
    includedTables: 'control-plane',
  },
  dbSnapshot: Buffer.from('SQLite format 3\0'),
  secrets: { SWARMY_SECRET_KEY: 'k', config: {} },
};

function hubWith(manager: boolean): AgentHub {
  const hub = { managerNode: () => (manager ? 'm1' : undefined) } as unknown as AgentHub;
  useMemoryKv(hub);
  return hub;
}

describe('swarm-kv in the controller bundle', () => {
  test('round-trips as the optional swarm-kv.json member; older bundles have none', async () => {
    const a = hubWith(true);
    await ingressConfigRepo.update({ hub: a }, 'org1', { driver: 'TRAEFIK' });
    const { section } = await exportKvForBundle(a, ['org1']);
    const blob = serializeBundle({ ...base, swarmKv: section });
    expect(blob.includes(Buffer.from(SWARM_KV_MEMBER))).toBe(true);
    expect(deserializeBundle(blob).swarmKv).toEqual(section);
    expect(deserializeBundle(serializeBundle(base)).swarmKv).toBeUndefined();
  });

  test('a restore onto a fresh swarm waits for the manager, then writes the documents back', async () => {
    const a = hubWith(true);
    await ingressConfigRepo.update({ hub: a }, 'org1', { driver: 'NONE', enabled: false });
    const { section } = await exportKvForBundle(a, ['org1']);

    // Fresh swarm, controller just restored: no manager yet.
    const dir = mkdtempSync(join(tmpdir(), 'kv-restore-'));
    let online = false;
    const b = { managerNode: () => (online ? 'm1' : undefined) } as unknown as AgentHub;
    useMemoryKv(b);
    await stashPendingKv(section, dir);
    expect(isKvRestorePending('org1')).toBe(true);
    // Mid-restore the store is unavailable, never the fresh swarm's defaults.
    const err = await ingressConfigRepo.get({ hub: b }, 'org1').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('PRECONDITION_FAILED');
    expect(await importPendingKv(b, dir)).toEqual({ written: 0, pending: ['org1'] });

    online = true;
    expect(await importPendingKv(b, dir)).toEqual({ written: 1, pending: [] });
    expect(isKvRestorePending('org1')).toBe(false);
    expect(await kvFor({ hub: b }, 'org1').get('ingress', 'org1')).toMatchObject({ driver: 'NONE', enabled: false });
    expect(await importPendingKv(b, dir)).toBeNull(); // drained
  });
});
