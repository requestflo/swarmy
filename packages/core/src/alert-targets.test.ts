import { describe, expect, it } from 'bun:test';
import {
  describeAlertTarget,
  isAnyTarget,
  normalizeAlertSelector,
  parseAlertSelector,
  selectorKey,
  selectorMatches,
  signalTargetKind,
  subjectFromResource,
  validateAlertSelector,
} from './alert-targets';
import { ALERT_SIGNALS, ALERT_SIGNAL_INFO } from './views';

describe('parseAlertSelector (the stored selectorJson)', () => {
  it('keeps only non-empty string keys it knows', () => {
    expect(parseAlertSelector({ app: 'storefront', service: ' checkout ', extra: 'x', server: 3 })).toEqual({
      app: 'storefront',
      service: 'checkout',
    });
  });
  it('reads anything malformed as "any"', () => {
    for (const bad of [null, undefined, 'app', 42, ['app'], {}]) expect(parseAlertSelector(bad)).toEqual({});
    expect(isAnyTarget(parseAlertSelector(null))).toBe(true);
  });
  it('normalises empty keys away so {app:""} and {} are the same value', () => {
    expect(normalizeAlertSelector({ app: '' })).toEqual({});
    expect(normalizeAlertSelector(undefined)).toEqual({});
  });
});

describe('every signal declares a target kind', () => {
  it('matches the catalogue', () => {
    for (const s of ALERT_SIGNALS) expect(signalTargetKind(s)).toBe(ALERT_SIGNAL_INFO[s].target);
    expect(signalTargetKind('disk-usage')).toBe('server');
    expect(signalTargetKind('error-rate')).toBe('app');
    expect(signalTargetKind('backup-failed')).toBeNull();
    expect(signalTargetKind('no-such-signal')).toBeNull();
  });
});

describe('validateAlertSelector (per the signal target kind)', () => {
  it('server signals take a server only', () => {
    expect(validateAlertSelector('disk-usage', { server: 'london-2' })).toBeNull();
    expect(validateAlertSelector('disk-usage', { app: 'storefront' })).toContain('one app');
  });
  it('app signals take an app and optionally a part of it', () => {
    expect(validateAlertSelector('error-rate', { app: 'storefront' })).toBeNull();
    expect(validateAlertSelector('error-rate', { app: 'storefront', service: 'checkout' })).toBeNull();
    expect(validateAlertSelector('error-rate', { service: 'checkout' })).toBe('pick the app before the part of it');
    expect(validateAlertSelector('error-rate', { server: 'wkr-1' })).toContain('one server');
  });
  it('signals with no target take only "any"', () => {
    expect(validateAlertSelector('backup-failed', {})).toBeNull();
    expect(validateAlertSelector('backup-failed', { app: 'blog' })).not.toBeNull();
    expect(validateAlertSelector('backup-failed', { server: 'wkr-1' })).not.toBeNull();
  });
  it('rejects names that are not Docker-name shaped', () => {
    expect(validateAlertSelector('error-rate', { app: 'store front' })).toContain('not a valid name');
  });
});

describe('subjectFromResource (the resource conventions)', () => {
  it.each([
    ['node:london-2', { server: 'london-2' }],
    ['node:london-2:forecast', { server: 'london-2' }],
    ['service:storefront_checkout', { app: 'storefront', service: 'checkout' }],
    ['service:web', { service: 'web' }],
    ['app:storefront', { app: 'storefront' }],
    ['stack:storefront', { app: 'storefront' }],
    ['release:storefront', { app: 'storefront' }],
    ['db:storefront/pg', { app: 'storefront' }],
    ['queue:storefront_worker/emails', { app: 'storefront', service: 'worker' }],
    ['errors:storefront:abc123', { app: 'storefront' }],
    ['backup:data_pgdata', {}],
    ['observability:store', {}],
    ['garbage', {}],
    ['node:', {}],
  ] as const)('%s', (resource, subject) => {
    expect(subjectFromResource(resource)).toEqual(subject);
  });
});

describe('selectorMatches', () => {
  const checkout = subjectFromResource('service:storefront_checkout');
  it('an empty selector matches everything', () => {
    expect(selectorMatches({}, checkout)).toBe(true);
    expect(selectorMatches({}, {})).toBe(true);
  });
  it('an app selector matches every part of that app, and nothing else', () => {
    expect(selectorMatches({ app: 'storefront' }, checkout)).toBe(true);
    expect(selectorMatches({ app: 'storefront' }, subjectFromResource('service:blog_web'))).toBe(false);
    expect(selectorMatches({ app: 'storefront' }, {})).toBe(false);
  });
  it('a part selector matches only that part', () => {
    expect(selectorMatches({ app: 'storefront', service: 'checkout' }, checkout)).toBe(true);
    expect(selectorMatches({ app: 'storefront', service: 'cart' }, checkout)).toBe(false);
  });
  it('a server selector matches that server and its forecast', () => {
    expect(selectorMatches({ server: 'london-2' }, subjectFromResource('node:london-2:forecast'))).toBe(true);
    expect(selectorMatches({ server: 'london-2' }, subjectFromResource('node:wkr-1'))).toBe(false);
  });
});

describe('describeAlertTarget + selectorKey', () => {
  it('says the target plainly', () => {
    expect(describeAlertTarget('error-rate', {})).toBe('any app');
    expect(describeAlertTarget('error-rate', { app: 'storefront' })).toBe('storefront');
    expect(describeAlertTarget('error-rate', { app: 'storefront', service: 'checkout' })).toBe('storefront / checkout');
    expect(describeAlertTarget('disk-usage', {})).toBe('any server');
    expect(describeAlertTarget('disk-usage', { server: 'london-2' })).toBe('london-2');
    expect(describeAlertTarget('backup-failed', {})).toBeNull();
  });
  it('has a stable text key', () => {
    expect(selectorKey({})).toBe('*');
    expect(selectorKey({ service: 'checkout', app: 'storefront' })).toBe('app=storefront,service=checkout');
  });
});
