import { describe, expect, it } from 'bun:test';
import { aiAttachmentKey, parseAiBudget } from './ai';
import { toDesired } from './desired';
import { parseAppConfig } from './parse';

const yaml = (ai: string) => `version: 1
app: shop
services:
  web:
    image: ghcr.io/acme/web:1
    port: 3000
  worker:
    image: ghcr.io/acme/worker:1
${ai}`;

describe('swarmy.yaml ai:', () => {
  it('parses budgets as USD/day', () => {
    expect(parseAiBudget('5/day')).toBe(5);
    expect(parseAiBudget('$2.50/day')).toBe(2.5);
    expect(parseAiBudget('5 / d')).toBe(5);
    expect(parseAiBudget(3)).toBe(3);
    expect(parseAiBudget('5/week')).toBeNull();
    expect(parseAiBudget('0/day')).toBeNull();
  });

  it('binds every service by default, with the allowlist and a shared budget', () => {
    const r = parseAppConfig(yaml('ai:\n  models: [smart, embed]\n  budget: "5/day"\n'));
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const d = toDesired(r.config!);
    expect(d.ai).toEqual({ models: ['smart', 'embed'], dailyBudgetUsd: 5, rpm: null, services: ['web', 'worker'] });
    expect(d.services.find((s) => s.name === 'web')?.ai).toEqual({ models: ['smart', 'embed'], dailyBudgetUsd: 5, rpm: null });
  });

  it('a changed allowlist changes the bound service signature (redeploy + rebind)', () => {
    const a = toDesired(parseAppConfig(yaml('ai:\n  models: [smart]\n')).config!);
    const b = toDesired(parseAppConfig(yaml('ai:\n  models: [smart, embed]\n')).config!);
    expect(a.services[0]!.sig).not.toBe(b.services[0]!.sig);
    expect(aiAttachmentKey(a.ai!)).not.toBe(aiAttachmentKey(b.ai!));
  });

  it('limits binding to the listed services', () => {
    const d = toDesired(parseAppConfig(yaml('ai:\n  models: [fast]\n  services: [worker]\n')).config!);
    expect(d.ai?.services).toEqual(['worker']);
    expect(d.services.find((s) => s.name === 'web')?.ai).toBeUndefined();
  });

  it('rejects an empty allowlist, a bad budget and unknown services', () => {
    const codes = (ai: string) => parseAppConfig(yaml(ai)).issues.filter((i) => i.severity === 'error').map((i) => i.path.join('.'));
    expect(codes('ai:\n  models: []\n')).toContain('ai.models');
    expect(codes('ai:\n  models: [smart]\n  budget: lots\n')).toContain('ai.budget');
    expect(codes('ai:\n  models: [smart]\n  services: [api]\n')).toContain('ai.services.0');
  });

  it('warns when a service sets a variable the binding owns', () => {
    const r = parseAppConfig(`version: 1
app: shop
services:
  web:
    image: x:1
    env:
      OPENAI_BASE_URL: https://api.openai.com/v1
ai:
  models: [smart]
`);
    expect(r.issues.some((i) => i.code === 'ai/env-overridden')).toBe(true);
  });
});
