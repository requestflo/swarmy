import { describe, expect, it } from 'bun:test';
import { PreviewsSchema, parseAppConfig, toDesired } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import { setPreviewRules } from './preview-rules.service';

const rules = PreviewsSchema.parse({ enabled: true, base_domain: 'preview.example.com', branches: ['feature/*'], ttl: '24h' });
const swarmSvc = (name: string, stack: string) => ({
  id: name,
  name,
  image: 'a:1',
  mode: 'replicated',
  replicas: 1,
  labels: { 'com.docker.stack.namespace': stack, 'swarmy.app.stack': stack },
});

function mockCtx(yaml: string, live = [swarmSvc('shop_web', 'shop'), swarmSvc('shop_worker', 'shop'), swarmSvc('blog_web', 'blog')]) {
  const dispatched: Array<{ service: string; add: Record<string, string>; removeKeys: string[] }> = [];
  const audits: Array<{ action: string; metadata: unknown }> = [];
  const desired = toDesired(parseAppConfig(yaml).config!);
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: {
      gitRepo: { findFirst: async () => ({ id: 'r1', appName: 'shop', configPath: 'swarmy.yaml' }) },
      appPlan: { findMany: async () => [{ desiredJson: desired }] },
      auditLog: { create: async ({ data }: { data: { action: string; metadata: unknown } }) => void audits.push(data) },
    },
    hub: {
      liveInventory: () => ({ services: live, containers: [] }),
      managerNode: () => 'n1',
      isOnline: () => true,
      dispatch: async (_n: string, _cmd: string, p: (typeof dispatched)[number]) => void dispatched.push(p),
    },
  } as unknown as OrgContext;
  return { ctx, dispatched, audits };
}

const NO_BLOCK = 'version: 1\napp: shop\nservices: { web: { image: "a:1" } }\n';

describe('apps.setPreviewRules (board 68: editing preview rules)', () => {
  it('stamps the rules on every service of the production stack, audited', async () => {
    const m = mockCtx(NO_BLOCK);
    const view = await setPreviewRules(m.ctx, { stack: 'shop', rules });
    expect(m.dispatched.map((d) => d.service)).toEqual(['shop_web', 'shop_worker']);
    expect(m.dispatched[0]).toEqual({ service: 'shop_web', add: { 'swarmy.previews.rules': JSON.stringify(rules) }, removeKeys: [] });
    expect(m.audits).toEqual([{ action: 'app.previews.rules', metadata: { stack: 'shop', rules, cleared: false, services: 2 } }].map((a) => expect.objectContaining(a)));
    expect(view).toMatchObject({ source: 'dashboard', enabled: true, branches: ['feature/*'], ttlSeconds: 86_400, baseDomain: 'preview.example.com' });
  });

  it('clearing removes the label', async () => {
    const m = mockCtx(NO_BLOCK);
    expect(await setPreviewRules(m.ctx, { stack: 'shop', rules: null })).toMatchObject({ source: 'default', enabled: false });
    expect(m.dispatched.every((d) => d.removeKeys[0] === 'swarmy.previews.rules' && Object.keys(d.add).length === 0)).toBe(true);
  });

  it('refuses when swarmy.yaml sets previews: — the file decides', async () => {
    const m = mockCtx(`${NO_BLOCK}previews: { enabled: true }\n`);
    await expect(setPreviewRules(m.ctx, { stack: 'shop', rules })).rejects.toThrow('swarmy.yaml sets previews:, so the file decides');
    expect(m.dispatched).toEqual([]);
  });

  it('refuses before production runs: the rules live on its services', async () => {
    const m = mockCtx(NO_BLOCK, [swarmSvc('blog_web', 'blog')]);
    await expect(setPreviewRules(m.ctx, { stack: 'shop', rules })).rejects.toThrow("shop isn't running yet");
    expect(m.audits).toEqual([]);
  });
});
