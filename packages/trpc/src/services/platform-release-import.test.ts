import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildPlatformManifest } from '@swarmy/core/platform-manifest';
import { importRelease, verifyRelease } from './platform-release.service';
import { startPlatformUpgrade, type PlatformUpgradeDeps } from './platform-upgrade.service';

// QA-070: import verified the raw bytes, but stored a Zod-parsed copy; Start
// re-verified the re-canonicalised object and a signed release could never
// start. A manifest carrying a field this controller does not know, signed as
// written (pretty-printed, as cosign signs the file), must import AND start.
describe('signed release: import → start verifies the raw signed bytes (QA-070)', () => {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  it('a manifest with an unknown field imports, then passes start verification (and every resume)', async () => {
    process.env.SWARMY_RELEASE_PUBKEY = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const m = buildPlatformManifest({ version: '99.0.0', channel: 'stable', commit: 'n' });
    const raw = `${JSON.stringify({ ...m, futureField: { rolloutWaves: 3 } }, null, 2)}\n`;
    const signature = sign('sha256', Buffer.from(raw, 'utf8'), kp.privateKey).toString('base64');

    let config: any = { id: 'pc1', orgId: 'org_1', channel: 'stable', feedUrl: null, autoApplyPatches: false, window: null, currentManifest: null, available: null };
    let created: any = null;
    const ctx: any = {
      activeOrgId: 'org_1',
      user: { id: 'u1' },
      hub: { managerNode: () => null, liveInventory: () => ({ services: [], containers: [] }) },
      db: {
        platformConfig: {
          upsert: async () => config,
          findUnique: async () => config,
          // Round-trip through JSON like the Json column does.
          update: async ({ data }: any) => (config = { ...config, ...JSON.parse(JSON.stringify(data)) }),
        },
        platformUpgradeRun: {
          findFirst: async () => null,
          create: async ({ data }: any) => (created = { id: 'run1', startedAt: new Date(), finishedAt: null, error: null, ...JSON.parse(JSON.stringify(data)) }),
        },
        registryConfig: { findUnique: async () => null },
        auditLog: { create: async () => ({}) },
      },
    };

    const imported = await importRelease(ctx, { manifest: raw, signature });
    expect(imported.verified).toBe(true);
    expect(config.available.raw).toBe(raw);
    // Unknown fields survive the display parse too.
    expect((config.available.manifest as Record<string, unknown>).futureField).toEqual({ rolloutWaves: 3 });

    const deps = { audit: async () => undefined } as unknown as PlatformUpgradeDeps;
    const run = await startPlatformUpgrade(ctx, {}, deps);
    expect(run.toVersion).toBe('99.0.0');
    // The run row keeps the signed bytes, so preflight's re-verification passes.
    expect(created.manifest).toBe(raw);
    expect(verifyRelease(created.manifest, created.signature).verified).toBe(true);
  });

  it('a tampered stored raw manifest is refused at start with the real reason', async () => {
    process.env.SWARMY_RELEASE_PUBKEY = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const m = buildPlatformManifest({ version: '99.0.0', channel: 'stable', commit: 'n' });
    const raw = JSON.stringify(m);
    const signature = sign('sha256', Buffer.from(raw, 'utf8'), kp.privateKey).toString('base64');
    const tampered = raw.replace('"commit":"n"', '"commit":"x"');
    const config: any = { orgId: 'org_1', currentManifest: null, available: { manifest: m, raw: tampered, signature, verified: true, source: 'bundle' } };
    const ctx: any = { activeOrgId: 'org_1', db: { platformConfig: { upsert: async () => config } } };
    await expect(startPlatformUpgrade(ctx, {}, {} as PlatformUpgradeDeps)).rejects.toThrow(/signature does not match/);
  });
});
