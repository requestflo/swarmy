import { describe, expect, it } from 'bun:test';
import { NATIVE_TARGET_NAME } from './backups.repo';
import { getOrCreateConfig, resolveControllerTarget } from './controllerBackup.service';
import { seedKv, useMemoryKv } from './swarm-kv.service';

/** QA-021: controller backups default to the native Garage target when one exists. */
function ctxWith(targets: Array<{ id: string; name: string }>) {
  const hub = { liveInventory: () => ({ services: [], containers: [] }) } as never;
  useMemoryKv(hub);
  for (const t of targets) {
    seedKv(hub, 'org1', 'bkp-target', t.id, { name: t.name, kind: 'S3', bucket: 'swarmy-backups', enabled: true });
  }
  const db = {
    organization: { findMany: async () => [{ id: 'org1' }] },
    auditLog: { create: async ({ data }: { data: unknown }) => data },
  } as never;
  return { db, hub, activeOrgId: 'org1', user: { id: 'u1' } } as never;
}

describe('resolveControllerTarget', () => {
  it('no configured target + a native Garage target → adopts (and persists) it', async () => {
    const ctx = ctxWith([{ id: 'tn', name: NATIVE_TARGET_NAME }]);
    const r = await resolveControllerTarget(ctx, await getOrCreateConfig(ctx));
    expect(r.target && (r.target as { id: string }).id).toBe('tn');
    expect(r.config.targetId).toBe('tn');
    expect((await getOrCreateConfig(ctx, 'org1')).targetId).toBe('tn');
  });

  it('no native target → still none (the preflight says what to set up)', async () => {
    const ctx = ctxWith([{ id: 't1', name: 'offsite-s3' }]);
    const r = await resolveControllerTarget(ctx, await getOrCreateConfig(ctx));
    expect(r.target).toBeNull();
    expect(r.config.targetId).toBeFalsy();
  });
});
