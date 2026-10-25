import { describe, expect, it } from 'bun:test';
import { currentFacts, type IngressDoc } from './ingress-settings-merge';
import { ingressRuleIssues, invalidIngressSettings, parseIngressFields } from './ingress-settings.checks';

const doc = (settings: Record<string, unknown> = {}): IngressDoc => ({ driver: 'CADDY', enabled: true, settings });
const facts = currentFacts(doc());
const fields = (issues: Array<{ field: string }>) => issues.map((i) => i.field);

describe('parseIngressFields — every field judged, every issue kept', () => {
  it('keeps the fields that parse and names each one that does not', () => {
    const { patch, issues } = parseIngressFields({
      enabled: false,
      driver: 'traefik',
      tls: { acmeEmail: 'nope', askUrl: 'not a url' },
      colour: 'blue',
      tunnel: { runToken: 'x'.repeat(30), secret: 1 },
    });
    expect(patch).toEqual({ enabled: false });
    expect(fields(issues)).toEqual(['driver', 'tls.acmeEmail', 'tls.askUrl', 'colour', 'tunnel']);
    expect(issues.find((i) => i.field === 'colour')?.message).toBe('Not an ingress setting');
  });
  it('nothing is an empty patch; null clears survive; a non-object is refused', () => {
    expect(parseIngressFields(undefined)).toEqual({ patch: {}, issues: [] });
    expect(parseIngressFields({ tunnel: null, controllerImage: null }).patch).toEqual({ tunnel: null, controllerImage: null });
    expect(fields(parseIngressFields(['x']).issues)).toEqual(['patch']);
  });
});

describe('ingressRuleIssues — judged on the settings after the patch', () => {
  it('a tunnel needs its run token to connect, and a real one', () => {
    expect(ingressRuleIssues({ tunnel: { replicas: 2 } }, facts, null)[0]?.message).toMatch(/run token first/);
    expect(ingressRuleIssues({ tunnel: { runToken: 'x'.repeat(30) } }, facts, null)[0]?.message).toMatch(/tunnel token/);
    expect(ingressRuleIssues({ tunnel: { runToken: 'x'.repeat(30) } }, facts, 't1')).toEqual([]);
  });
  it('on-demand TLS needs an email or an ask endpoint', () => {
    expect(ingressRuleIssues({ tls: { onDemand: true, askUrl: 'https://x/ask' } }, facts, null)).toEqual([]);
    const withEmail = currentFacts(doc({ globalOptions: { email: 'a@x.io', onDemandTls: true } }));
    expect(fields(ingressRuleIssues({ tls: { acmeEmail: null } }, withEmail, null))).toEqual(['tls.onDemand']);
  });
  it('a file country database needs a path; a base must be a domain name (blank clears)', () => {
    expect(fields(ingressRuleIssues({ geoip: { mode: 'file' } }, facts, null))).toEqual(['geoip.path']);
    expect(ingressRuleIssues({ geoip: { mode: 'file', path: '/g/c.mmdb' } }, facts, null)).toEqual([]);
    expect(ingressRuleIssues({ autoAddressBase: 'not a domain' }, facts, null)[0]?.message).toMatch(/not a domain name/);
    expect(ingressRuleIssues({ autoAddressBase: '  ' }, facts, null)).toEqual([]);
  });
  it('collects every rule at once', () => {
    const issues = ingressRuleIssues({ tls: { onDemand: true }, geoip: { mode: 'file' }, autoAddressBase: 'x y' }, facts, null);
    expect(fields(issues)).toEqual(['tls.onDemand', 'geoip.path', 'autoAddressBase']);
  });
});

describe('invalidIngressSettings — one refusal naming every field', () => {
  it('a lone rule keeps its plain sentence; more name each field', () => {
    const lone = invalidIngressSettings([], [{ field: 'tunnel.runToken', message: 'Connect the tunnel with its run token first.' }]);
    expect(lone.code).toBe('BAD_REQUEST');
    expect(lone.message).toBe('Connect the tunnel with its run token first.');
    const many = invalidIngressSettings([{ field: 'driver', message: 'Invalid enum value' }], [{ field: 'geoip.path', message: 'a file path is required' }]);
    expect(many.message).toBe('invalid ingress settings: driver: Invalid enum value; geoip.path: a file path is required');
    expect((many.cause as unknown as { fieldErrors: unknown }).fieldErrors).toEqual([
      { field: 'driver', message: 'Invalid enum value' },
      { field: 'geoip.path', message: 'a file path is required' },
    ]);
  });
});
