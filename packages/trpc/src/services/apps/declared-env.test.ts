import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../../context';
import type { AppConfigFileView } from './config-file';
import { readDeclaredEnv } from './declared-env';

const YAML = `version: 1
app: shop
env: { NODE_ENV: production }
services:
  web: { image: ghcr.io/x/web:1, env: { LOG_LEVEL: warn } }
environments:
  staging: { branch: staging, env: { NODE_ENV: staging } }
`;

const file = (text: string | null): AppConfigFileView => ({
  repoId: 'r1', environment: 'production', path: 'swarmy.yaml', sha: 'a'.repeat(40), text,
  fetchedAt: '2026-10-26T00:00:00Z', lastWebhookAt: null, lastPollAt: null, previewDomain: null,
});

const ctx = {
  activeOrgId: 'org1',
  db: {
    appPlan: {
      findMany: async () => [{ environment: 'qa', stack: 'shop-qa', desiredJson: { dashboard: { branch: 'qa', from: 'staging', secretSlots: [] } } }],
    },
  },
} as unknown as OrgContext;

describe('readDeclaredEnv (apps.declaredEnv, board 58)', () => {
  it('is null for a stack no git app planned', async () => {
    expect(await readDeclaredEnv(ctx, { stack: 'billing' }, async () => null)).toBeNull();
  });

  it('every environment with its stack; a clone reads as the one it came from', async () => {
    const v = (await readDeclaredEnv(ctx, { stack: 'shop' }, async () => file(YAML)))!;
    expect(v.reason).toBeNull();
    expect(v.environments).toEqual([
      { environment: 'production', stack: 'shop', services: { web: { NODE_ENV: 'env.NODE_ENV', LOG_LEVEL: 'services.web.env.LOG_LEVEL' } } },
      { environment: 'staging', stack: 'shop-staging', services: { web: { NODE_ENV: 'environments.staging.env.NODE_ENV', LOG_LEVEL: 'services.web.env.LOG_LEVEL' } } },
      { environment: 'qa', stack: 'shop-qa', services: { web: { NODE_ENV: 'environments.staging.env.NODE_ENV', LOG_LEVEL: 'services.web.env.LOG_LEVEL' } } },
    ]);
  });

  it('locks nothing, and says why, when the file is missing or broken', async () => {
    expect(await readDeclaredEnv(ctx, { stack: 'shop' }, async () => file(null))).toMatchObject({ reason: "swarmy.yaml isn't in that commit", environments: [] });
    const broken = await readDeclaredEnv(ctx, { stack: 'shop' }, async () => file('version: 1\napp: shop\n'));
    expect(broken?.environments).toEqual([]);
    expect(broken?.reason).toMatch(/^swarmy.yaml doesn't parse/);
  });
});
