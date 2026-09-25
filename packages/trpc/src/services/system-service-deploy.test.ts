import { describe, expect, it } from 'bun:test';
import { toServiceCreateOptions } from '@swarmy/core/docker';
import { ensureDnsService, dnsServiceSpec } from './dns-deploy.service';
import { SPEC_SIGNATURE_LABEL, SYSTEM_UPDATE_CONFIG, specSignature, specUnchanged, withSpecSignature } from './system-service-deploy';

/** QA-049: an unchanged desired spec dispatches nothing; system updates roll one task at a time. */
const settings = { geoipSource: 'none' } as never;

function ctxWith(liveLabels: Record<string, string> | null) {
  const calls: Array<{ cmd: string; payload: any }> = [];
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-test-secret-key-000';
  const ctx = {
    activeOrgId: 'org1',
    user: null,
    db: { auditLog: { create: async ({ data }: any) => data } },
    hub: {
      liveInventory: () => ({
        services: liveLabels ? [{ id: 'd1', name: 'swarmy-dns', image: 'x', mode: 'global', runningReplicas: 2, labels: liveLabels, networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0 }] : [],
        containers: [],
      }),
      managerNode: () => 'n1',
      isOnline: () => true,
      dispatch: async (_n: string, cmd: string, payload: any) => {
        calls.push({ cmd, payload });
        return {};
      },
    },
  } as never;
  return { ctx, calls };
}

describe('system service converge', () => {
  it('the signature is stable over key order and ignores its own label', () => {
    const a = dnsServiceSpec(settings);
    const b = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(specSignature(a)).toBe(specSignature(b));
    expect(specSignature(withSpecSignature(a))).toBe(specSignature(a));
    expect(specSignature({ ...a, env: { ...a.env, X: '1' } })).not.toBe(specSignature(a));
  });

  it('golden: swarmy-dns already on the desired spec → no service.deploy', async () => {
    const desired = withSpecSignature({ ...dnsServiceSpec(settings), updateConfig: SYSTEM_UPDATE_CONFIG });
    const { ctx, calls } = ctxWith({ ...desired.labels! });
    await ensureDnsService(ctx, settings);
    expect(calls.filter((c) => c.cmd === 'service.deploy')).toEqual([]);
    expect(specUnchanged({ labels: desired.labels! }, desired)).toBe(true);
  });

  it('a real change (or a service from before the label) deploys, stamped and rolling one task at a time', async () => {
    const { ctx, calls } = ctxWith({ 'swarmy.managed': 'true' });
    await ensureDnsService(ctx, settings);
    const deploy = calls.find((c) => c.cmd === 'service.deploy')!;
    expect(deploy.payload.spec.labels[SPEC_SIGNATURE_LABEL]).toMatch(/^[0-9a-f]{16}$/);
    expect(deploy.payload.spec.updateConfig).toEqual(SYSTEM_UPDATE_CONFIG);
  });

  it('updateConfig reaches Docker as UpdateConfig', () => {
    const opts = toServiceCreateOptions({ ...dnsServiceSpec(settings), updateConfig: SYSTEM_UPDATE_CONFIG } as never) as any;
    expect(opts.UpdateConfig).toEqual({ Parallelism: 1, Order: 'stop-first', FailureAction: 'rollback', Monitor: 15_000_000_000, Delay: 10_000_000_000 });
  });
});
