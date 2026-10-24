import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../../context';
import type { AppConfigFileView } from './config-file';
import { readEnvLayers } from './env-layers';

const YAML = `version: 1
app: shop
env: { NODE_ENV: production, SESSION_SECRET: s3cr3t-value-here }
services:
  web: { image: ghcr.io/x/web:1, env: { LOG_LEVEL: warn } }
environments:
  staging: { branch: staging, env: { NODE_ENV: staging } }
`;

const file = (text: string | null): AppConfigFileView => ({
  repoId: 'r1', environment: 'production', path: 'swarmy.yaml', sha: 'a'.repeat(40), text,
  fetchedAt: '2026-10-24T00:00:00Z', lastWebhookAt: null, lastPollAt: null, previewDomain: null,
});

const ctx = {
  activeOrgId: 'org1',
  db: {
    appPlan: {
      findMany: async () => [{ environment: 'qa', stack: 'shop-qa', desiredJson: { dashboard: { branch: 'qa', from: 'production', secretSlots: [] } } }],
    },
  },
} as unknown as OrgContext;

describe('readEnvLayers (apps.envLayers)', () => {
  it('is null for a stack no git app planned', async () => {
    expect(await readEnvLayers(ctx, { stack: 'billing' }, async () => null)).toBeNull();
  });

  it('layers the file’s environments plus the dashboard ones, secrets masked', async () => {
    const v = (await readEnvLayers(ctx, { stack: 'shop' }, async () => file(YAML)))!;
    expect(v.layers?.environments).toEqual(['production', 'staging', 'qa']);
    expect(v.dashboard).toEqual(['qa']);
    const node = v.layers?.rows.find((r) => r.key === 'NODE_ENV');
    expect(node?.envs.staging).toEqual({ value: 'staging', origin: 'environment', services: [] });
    expect(node?.envs.qa).toEqual({ value: 'production', origin: 'shared', services: [] });
    expect(JSON.stringify(v)).not.toContain('s3cr3t');
  });

  it('says why when the commit has no valid file', async () => {
    expect((await readEnvLayers(ctx, { stack: 'shop' }, async () => file(null)))?.reason).toBe("swarmy.yaml isn't in that commit");
    expect((await readEnvLayers(ctx, { stack: 'shop' }, async () => file('version: 2\n')))?.reason).toContain("doesn't parse");
  });
});
