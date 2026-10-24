import { describe, expect, it } from 'bun:test';
import { parseAppConfig, toDesired, type DesiredApp } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import { compileServices, type Attachment } from './compile';
import { mountedFamilies, withExistingOwnSecrets } from './own-secrets';

const YAML = `version: 1
app: shop
services:
  web:
    image: ghcr.io/x/web:1
    env:
      STRIPE_KEY: \${{ secrets.stripe-key }}
  api:
    image: ghcr.io/x/api:1
    secrets: [stripe-key, sendgrid]
environments:
  qa:
    branch: qa
`;
const desired = (environment?: string): DesiredApp => toDesired(parseAppConfig(YAML).config!, environment ? { environment } : {});

/** A ctx whose live inventory is `shop-qa` mounting its own stripe-key family (the clone filled it). */
const ctx = {
  activeOrgId: 'org1',
  hub: {
    liveInventory: () => ({
      services: ['web', 'api'].map((n) => ({
        id: n, name: `shop-qa_${n}`, image: 'x', mode: 'replicated', replicas: 1, runningReplicas: 1, desiredReplicas: 1,
        labels: { 'com.docker.stack.namespace': 'shop-qa' }, networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
        secrets: ['stripe-key.qa__v2'],
      })),
      containers: [],
    }),
  },
} as unknown as OrgContext;

const secretAttachments = (d: DesiredApp): Attachment[] =>
  compileServices(d, { web: 'w@sha256:1', api: 'a@sha256:2' }).attachments.filter((a) => a.kind === 'secret');

describe('adoption keeps the environment’s own secret family (no silent switch to the shared one)', () => {
  it('wires <x>.<env> where the app reads x — the same file path and the same env var', async () => {
    const d = await withExistingOwnSecrets(ctx, desired('qa'), async () => ['stripe-key', 'stripe-key.qa', 'sendgrid']);
    expect(secretAttachments(d)).toEqual<Attachment[]>([
      { kind: 'secret', service: 'api', family: 'sendgrid' },
      { kind: 'secret', service: 'api', family: 'stripe-key.qa', target: 'stripe-key' },
      { kind: 'secret', service: 'web', family: 'stripe-key.qa', envName: 'STRIPE_KEY' },
    ]);
  });

  it('without an own family the shared one is wired, as before', async () => {
    const d = await withExistingOwnSecrets(ctx, desired('qa'), async () => ['stripe-key', 'sendgrid']);
    expect(secretAttachments(d)).toContainEqual({ kind: 'secret', service: 'api', family: 'stripe-key' });
    expect(secretAttachments(d)).toContainEqual({ kind: 'secret', service: 'web', family: 'stripe-key', envName: 'STRIPE_KEY' });
  });

  it('falls back to what the stack mounts when no manager answers', async () => {
    const d = await withExistingOwnSecrets(ctx, desired('qa'), async () => {
      throw new Error('no manager online');
    });
    expect(d.services.find((s) => s.name === 'api')?.ownSecrets).toEqual({ 'stripe-key': 'stripe-key.qa' });
  });

  it('never looks for production (it has no environment of its own to prefer)', async () => {
    let asked = false;
    const prod = desired();
    expect(await withExistingOwnSecrets(ctx, prod, async () => ((asked = true), []))).toBe(prod);
    expect(asked).toBe(false);
  });
});

describe('mountedFamilies', () => {
  it('reads families off the stack’s managed secret refs only', () => {
    const services = ctx.hub.liveInventory('org1').services.map((s) => ({ ...s, stack: 'shop-qa', secrets: ['stripe-key.qa__v2', 'raw-secret'] }));
    expect(mountedFamilies(services as never, 'shop-qa')).toEqual(['stripe-key.qa']);
    expect(mountedFamilies(services as never, 'shop')).toEqual([]);
  });
});
