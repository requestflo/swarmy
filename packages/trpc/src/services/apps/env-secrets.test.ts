import { describe, expect, it } from 'bun:test';
import type { DashboardEnvMarker } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import { setEnvironmentSecret, type EnvSecretOps } from './env-secrets';

const MARKER: DashboardEnvMarker = {
  branch: 'qa',
  from: 'production',
  secretSlots: [{ family: 'stripe-key', envFamily: 'stripe-key.qa', consumers: [{ service: 'api' }, { service: 'web', envName: 'STRIPE_KEY' }] }],
};

const rows = [
  { orgId: 'org1', repoId: 'r1', environment: 'qa', stack: 'shop-qa', prNumber: 0, desiredJson: { dashboard: MARKER } },
  { orgId: 'org1', repoId: 'r1', environment: 'staging', stack: 'shop-staging', prNumber: 0, desiredJson: {} },
];
const ctx = {
  activeOrgId: 'org1',
  db: {
    appPlan: {
      findFirst: async ({ where }: { where: { stack: string } }) => rows.find((r) => r.stack === where.stack) ?? null,
      findMany: async () => rows,
    },
  },
} as unknown as OrgContext;

/** Records every call; `existing` families already exist, `mounted` services already read the env family. */
function fakeOps(existing: string[] = [], mounted: string[] = []) {
  const calls: string[] = [];
  const ops: EnvSecretOps = {
    exists: async (_c, f) => existing.includes(f),
    create: async (_c, f, _v, stack) => (calls.push(`create ${f} (${stack})`), { version: 1 }),
    rotate: async (_c, f) => (calls.push(`rotate ${f}`), { version: 2 }),
    attach: async (_c, a) => void calls.push(`attach ${a.family} → ${a.service}${a.target ? ` at ${a.target}` : ''}${a.envName ? ` as $${a.envName}` : ''}`),
    mounted: () => mounted,
  };
  return { ops, calls };
}

describe('setEnvironmentSecret — secrets are never copied, each environment has its own', () => {
  it('creates the environment’s own family and mounts it where the app reads it', async () => {
    const { ops, calls } = fakeOps();
    const res = await setEnvironmentSecret(ctx, { stack: 'shop-qa', family: 'stripe-key', value: 'sk_test_123' }, ops);
    expect(calls).toEqual([
      'create stripe-key.qa (shop-qa)',
      'attach stripe-key.qa → shop-qa_api at stripe-key',
      'attach stripe-key.qa → shop-qa_web as $STRIPE_KEY',
    ]);
    expect(res).toEqual({ family: 'stripe-key', envFamily: 'stripe-key.qa', version: 1, services: ['shop-qa_api', 'shop-qa_web'] });
    expect(JSON.stringify(res)).not.toContain('sk_test');
  });

  it('setting it again rotates that family; services already on it are not re-attached', async () => {
    const { ops, calls } = fakeOps(['stripe-key.qa'], ['shop-qa_api', 'shop-qa_web']);
    const res = await setEnvironmentSecret(ctx, { stack: 'shop-qa', family: 'stripe-key', value: 'sk_test_456' }, ops);
    expect(calls).toEqual(['rotate stripe-key.qa']);
    expect(res.version).toBe(2);
  });

  it('refuses a swarmy.yaml environment, an unknown stack and an unknown slot', async () => {
    const { ops, calls } = fakeOps();
    await expect(setEnvironmentSecret(ctx, { stack: 'shop-staging', family: 'stripe-key', value: 'x' }, ops)).rejects.toThrow('from swarmy.yaml');
    await expect(setEnvironmentSecret(ctx, { stack: 'billing', family: 'stripe-key', value: 'x' }, ops)).rejects.toThrow('not found');
    await expect(setEnvironmentSecret(ctx, { stack: 'shop-qa', family: 'sendgrid', value: 'x' }, ops)).rejects.toThrow('not found');
    expect(calls).toEqual([]);
  });
});
