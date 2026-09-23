import { describe, expect, test } from 'bun:test';
import { dashboardDomainFor, dashboardDriverWarning } from './ingress.service';

const D = 'swarmy.46-101-22-121.sslip.io';

describe('dashboardDomainFor', () => {
  test('served when the controller env and the org binding agree', () => {
    expect(dashboardDomainFor({ dashboardDomain: D }, { SWARMY_DASHBOARD_DOMAIN: D })).toBe(D);
  });

  test('case/whitespace-insensitive match', () => {
    expect(dashboardDomainFor({ dashboardDomain: D.toUpperCase() }, { SWARMY_DASHBOARD_DOMAIN: ` ${D} ` })).toBe(D);
  });

  test('env removed (installer --no-https) → not served even with a stale binding', () => {
    expect(dashboardDomainFor({ dashboardDomain: D }, {})).toBeNull();
  });

  test('an org without the seed binding never claims the domain', () => {
    expect(dashboardDomainFor({}, { SWARMY_DASHBOARD_DOMAIN: D })).toBeNull();
    expect(dashboardDomainFor({ dashboardDomain: 'other.example.com' }, { SWARMY_DASHBOARD_DOMAIN: D })).toBeNull();
  });
});

describe('dashboardDriverWarning', () => {
  test('no domain → no warning', () => {
    expect(dashboardDriverWarning('none', true, null)).toBeNull();
  });
  test('caddy + enabled serves it', () => {
    expect(dashboardDriverWarning('caddy', true, D)).toBeNull();
  });
  test('switching the driver away from caddy warns', () => {
    expect(dashboardDriverWarning('none', true, D)).toContain(`https://${D}`);
    expect(dashboardDriverWarning('cloudflared', true, D)).toContain('Caddy');
  });
  test('disabling ingress warns', () => {
    expect(dashboardDriverWarning('caddy', false, D)).toContain('disabled');
  });
});
