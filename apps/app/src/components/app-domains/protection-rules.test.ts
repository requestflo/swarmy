import { describe, expect, test } from 'bun:test';
import type { RouteProtection } from '@/components/ingress/protection-model';
import { isOn, patch, ruleSay, rulesOn, switchedOff, switchedOn, tokens, withRate } from './protection-rules';

const base: RouteProtection = {
  rateLimit: { requests: 100, windowSeconds: 60, key: 'ip' },
  ipAllow: [],
  ipDeny: ['45.155.205.0/24'],
  blockBots: true,
  requiredHeaders: [{ name: 'X-Env', value: 'prod' }],
};

describe('protection cards', () => {
  test('switching a card off drops only its rule', () => {
    const p = switchedOff(base, 'rate');
    expect(p?.rateLimit).toBeUndefined();
    expect(p?.blockBots).toBe(true);
    expect(p?.requiredHeaders).toEqual([{ name: 'X-Env', value: 'prod' }]);
    expect(isOn(switchedOff(base, 'ips'), 'ips')).toBe(false);
  });

  test('nothing enforced is null, as the form saves it', () => {
    expect(switchedOff({ ipAllow: [], ipDeny: [], blockBots: true, requiredHeaders: [] }, 'bots')).toBeNull();
    expect(patch(null, {})).toBeNull();
  });

  test('rate presets keep the key; switching on starts at 100 a minute', () => {
    expect(withRate(base, 300)?.rateLimit).toEqual({ requests: 300, windowSeconds: 60, key: 'ip' });
    const hdr = patch(null, { rateLimit: { requests: 5, windowSeconds: 1, key: 'header', header: 'X-Api-Key' } });
    expect(withRate(hdr, 60)?.rateLimit).toEqual({ requests: 60, windowSeconds: 60, key: 'header', header: 'X-Api-Key' });
    expect(switchedOn(null, 'rate')?.rateLimit?.requests).toBe(100);
  });

  test('scanner paths live in WAF-lite and keep its other rules', () => {
    const on = switchedOn(null, 'scanners');
    expect(on?.waf).toEqual({ blockScannerPaths: true, blockMethods: [], denyQueryPatterns: [] });
    expect(switchedOff(on, 'scanners')).toBeNull();
    const methods = patch(null, { waf: { blockScannerPaths: true, blockMethods: ['TRACE'], denyQueryPatterns: [] } });
    expect(switchedOff(methods, 'scanners')?.waf).toEqual({ blockScannerPaths: false, blockMethods: ['TRACE'], denyQueryPatterns: [] });
  });

  test('cards say what is enforced', () => {
    expect(ruleSay(base, 'rate', 'web')).toBe('Each visitor IP gets 100 requests a minute.');
    expect(ruleSay(patch(null, { countryDeny: ['RU', 'KP'] }), 'countries', 'web')).toBe('Turns away visitors from RU, KP. Everyone else gets in.');
    expect(ruleSay(base, 'ips', 'web')).toBe('Turns away 45.155.205.0/24.');
    expect(ruleSay(null, 'size', 'web')).toBe('No size limit on uploads.');
    expect(rulesOn(base)).toBe(3);
    expect(tokens('gb, ie  fr')).toEqual(['gb', 'ie', 'fr']);
  });
});
