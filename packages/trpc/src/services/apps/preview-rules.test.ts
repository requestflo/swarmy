import { describe, expect, it } from 'bun:test';
import { PreviewsSchema, desiredPreviews, parseAppConfig, toDesired } from '@swarmy/app-config';
import { compileServices } from './compile';
import { PREVIEW_RULES_LABEL, effectivePreviews, fileSetsPreviews, previewRulesLabels, readDashboardPreviews } from './preview-rules';

const saved = PreviewsSchema.parse({ enabled: true, base_domain: 'preview.example.com', ttl: '24h', sleep_after: '30m', size: 'small' });
const svc = (stack: string, rules?: string) => ({ labels: { 'swarmy.app.stack': stack, ...(rules !== undefined ? { [PREVIEW_RULES_LABEL]: rules } : {}) } });
const NO_BLOCK = 'version: 1\napp: shop\nservices:\n  web:\n    image: "a:1"\n    port: 3000\n    domains: [shop.example.com]\n';

describe('preview rules saved on the production stack (board 68)', () => {
  it('reads the first valid copy off the stack’s services; anything else is "nothing saved"', () => {
    expect(readDashboardPreviews([svc('blog', JSON.stringify(saved)), svc('shop', 'not json'), svc('shop', JSON.stringify(saved))], 'shop')).toEqual(saved);
    expect(readDashboardPreviews([svc('shop', '{"enabled": "yes"}'), svc('shop')], 'shop')).toBeNull();
  });

  it('production’s compose re-stamps them while the dashboard holds them, never on a preview', () => {
    const cfg = parseAppConfig(NO_BLOCK).config!;
    const prod = toDesired(cfg, { dashboardPreviews: saved });
    expect(previewRulesLabels(prod)).toEqual({ [PREVIEW_RULES_LABEL]: JSON.stringify(saved) });
    const compiled = compileServices(prod, { web: 'reg/shop@sha256:abc' }, {});
    expect(JSON.stringify(compiled)).toContain(PREVIEW_RULES_LABEL);
    expect(previewRulesLabels(toDesired(cfg, { dashboardPreviews: saved, preview: { pr: 2, baseDomain: 'preview.example.com' } }))).toEqual({});
    // Once swarmy.yaml names previews:, the file decides and the label goes with the next deploy.
    expect(previewRulesLabels(toDesired(parseAppConfig(`${NO_BLOCK}previews: { enabled: true }\n`).config!, { dashboardPreviews: saved }))).toEqual({});
  });

  it('the rules in force: the file’s, else what’s saved now (fresher than the last plan), else the plan’s', () => {
    const file = toDesired(parseAppConfig(`${NO_BLOCK}previews: { enabled: true, ttl: 48h }\n`).config!).previews;
    expect(effectivePreviews(file, saved)).toBe(file);
    expect(effectivePreviews(desiredPreviews({}, null), saved)).toMatchObject({ source: 'dashboard', ttlSeconds: 86_400, sleepAfterSeconds: 1800, size: 'small' });
    expect(effectivePreviews(desiredPreviews({}, null), null)).toMatchObject({ source: 'default' });
    expect(effectivePreviews(null, null)).toBeNull();
  });

  it('a plan from before the rules said where they came from counts as the file’s when it isn’t the defaults', () => {
    const { source: _s, ...old } = toDesired(parseAppConfig(`${NO_BLOCK}previews: { enabled: true }\n`).config!).previews;
    expect(fileSetsPreviews(old as never)).toBe(true);
    const { source: _d, ...plain } = desiredPreviews({}, null);
    expect(fileSetsPreviews(plain as never)).toBe(false);
  });
});
