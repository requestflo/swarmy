import { describe, expect, it } from 'bun:test';
import type { AppEnvironment, GitApp } from '../gitops-types';
import { cloneSteps, maskOption, nameProblem, slotReaders, slotsLeft, suggestName } from './clone-model';

const env = (environment: string, extra: Partial<AppEnvironment> = {}): AppEnvironment => ({
  environment, branch: environment === 'production' ? 'main' : environment, stack: environment === 'production' ? 'shop' : `shop-${environment}`, latest: null, keptVolumes: [], ...extra,
});
const app = (envs: AppEnvironment[], scrub?: string): GitApp => ({
  repoId: 'r1', url: 'https://github.com/x/shop', fullName: 'x/shop', branch: 'main', configPath: 'swarmy.yaml', appName: 'shop',
  requireApproval: false, enforceDrift: false, environments: envs, previews: [], drift: null,
  previewRules: scrub ? { enabled: true, branches: [], ttlSeconds: 0, resources: 'isolated', data: { from: 'production', scrub } } : null,
});

describe('clone model', () => {
  it('suggests the first free name', () => {
    expect(suggestName(app([env('production')]))).toBe('qa');
    expect(suggestName(app([env('production'), env('qa'), env('qa-2')]))).toBe('qa-3');
  });

  it('checks the name like the controller does', () => {
    const a = app([env('production'), env('staging')]);
    expect(nameProblem(a, '')).toBe('Give it a name');
    expect(nameProblem(a, '9lives')).toContain('Lowercase');
    expect(nameProblem(a, 'preview')).toContain('reserved');
    expect(nameProblem(a, 'staging')).toBe('shop already has staging');
    expect(nameProblem(a, 'qa')).toBeNull();
  });

  it('offers the mask step only when swarmy.yaml has one', () => {
    expect(maskOption(app([env('production')], 'db/mask.sql'))).toEqual({ available: true, hint: 'runs db/mask.sql on the copy before anything connects' });
    expect(maskOption(app([env('production')])).available).toBe(false);
  });

  it('says what it makes: its own stack, a copy or an empty database, no secrets copied, no expiry', () => {
    const steps = Object.fromEntries(cloneSteps(app([env('production')]), env('production'), 'qa', 'qa', 'copy', true));
    expect(steps['Its own copy of shop']).toContain('stack shop-qa');
    expect(steps['Database']).toBe('a copy of production’s newest backup, masked');
    expect(steps['Secrets']).toContain('none copied');
    expect(steps['Kept']).toContain('never expires');
  });

  it('counts the empty slots and names who reads each', () => {
    const slot = { family: 'stripe-key', envFamily: 'stripe-key.qa', consumers: [{ service: 'api' }, { service: 'web', envName: 'STRIPE_KEY' }], filled: false };
    expect(slotsLeft([slot, { ...slot, family: 'x', filled: true }])).toBe(1);
    expect(slotReaders(slot)).toBe('api reads /run/secrets/stripe-key · web reads $STRIPE_KEY');
  });
});
