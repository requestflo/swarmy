import { describe, expect, it } from 'bun:test';
import {
  AUTO_ADDRESS_HOST_LABEL,
  autoAddressEligibility,
  autoLabelFor,
  pickHttpPort,
  planAutoAddresses,
  sslipBaseFor,
  type AutoAddressCandidate,
} from './auto-address';

const cand = (over: Partial<AutoAddressCandidate> = {}): AutoAddressCandidate => ({
  serviceId: 'id-web',
  serviceName: 'shop_web',
  stack: 'shop',
  labels: {},
  ports: [{ target: 3000, published: 3000, protocol: 'tcp' }],
  exposedTcp: [],
  routeHosts: [],
  ...over,
});
const BASE = '203-0-113-10.sslip.io';

describe('sslipBaseFor', () => {
  it('reuses the installer dashboard base (dashed or dotted)', () => {
    expect(sslipBaseFor({ dashboardDomain: 'swarmy.203-0-113-10.sslip.io', edgeIps: ['198.51.100.1'] })).toBe(BASE);
    expect(sslipBaseFor({ dashboardDomain: 'swarmy.203.0.113.10.nip.io', edgeIps: [] })).toBe('203-0-113-10.nip.io');
  });
  it('falls back to the first edge IPv4, then IPv6; null with no IP', () => {
    expect(sslipBaseFor({ dashboardDomain: 'swarmy.acme.com', edgeIps: ['2001:db8::1', '203.0.113.10'] })).toBe(BASE);
    expect(sslipBaseFor({ edgeIps: ['2001:db8::1'] })).toBe('2001-db8--1.sslip.io');
    expect(sslipBaseFor({ edgeIps: [] })).toBeNull();
  });
});

describe('autoLabelFor', () => {
  it('<service>-<stack>, stack prefix dropped; standalone = service', () => {
    expect(autoLabelFor('shop', 'shop_web')).toBe('web-shop');
    expect(autoLabelFor('shop', 'web')).toBe('web-shop');
    expect(autoLabelFor('(ungrouped)', 'My_API')).toBe('my-api');
    expect(autoLabelFor(null, 'blog')).toBe('blog');
  });
  it('always a valid ≤63 label', () => {
    const long = autoLabelFor('a'.repeat(40), `${'a'.repeat(40)}_${'b'.repeat(40)}`);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });
});

describe('pickHttpPort', () => {
  it('prefers common HTTP ports, never databases', () => {
    expect(pickHttpPort([5432, 8080, 3000])).toBe(8080);
    expect(pickHttpPort([5432, 6379])).toBeNull();
    expect(pickHttpPort([7777, 6000])).toBe(6000);
  });
});

describe('autoAddressEligibility', () => {
  it('published HTTP port qualifies', () => {
    expect(autoAddressEligibility(cand())).toEqual({ port: 3000 });
  });
  it('expose-only needs an explicit public intent or opt-in', () => {
    const exposeOnly = cand({ ports: [], exposedTcp: [8080] });
    expect(autoAddressEligibility(exposeOnly)).toEqual({ skip: 'not-public' });
    expect(autoAddressEligibility({ ...exposeOnly, labels: { 'swarmy.expose': 'public' } })).toEqual({ port: 8080 });
    expect(autoAddressEligibility({ ...exposeOnly, labels: { 'swarmy.ingress.auto': 'true' } })).toEqual({ port: 8080 });
  });
  it('never: opted out, private intent, managed data, swarmy system, no HTTP port', () => {
    expect(autoAddressEligibility(cand({ labels: { 'swarmy.ingress.auto': 'false' } }))).toEqual({ skip: 'opted-out' });
    expect(autoAddressEligibility(cand({ labels: { 'swarmy.expose': 'private' } }))).toEqual({ skip: 'not-public' });
    expect(autoAddressEligibility(cand({ labels: { 'swarmy.db.cluster': 'pg' } }))).toEqual({ skip: 'managed-data' });
    expect(autoAddressEligibility(cand({ serviceName: 'swarmy_controller', stack: 'swarmy' }))).toEqual({ skip: 'system' });
    expect(autoAddressEligibility(cand({ ports: [{ target: 5432, published: 5432, protocol: 'tcp' }] }))).toEqual({ skip: 'no-http-port' });
  });
  it('port override label wins', () => {
    expect(autoAddressEligibility(cand({ labels: { 'swarmy.ingress.auto.port': '9001' } }))).toEqual({ port: 9001 });
  });
});

describe('planAutoAddresses', () => {
  it('stamps a qualifying first deploy', () => {
    expect(planAutoAddresses({ candidates: [cand()], base: BASE, takenHosts: [] })).toEqual([
      { kind: 'add', serviceId: 'id-web', serviceName: 'shop_web', host: `web-shop.${BASE}`, port: 3000 },
    ]);
  });
  it('steady state is empty; custom domain / removal are respected', () => {
    const stamped = cand({ labels: { [AUTO_ADDRESS_HOST_LABEL]: `web-shop.${BASE}` }, routeHosts: [`web-shop.${BASE}`] });
    expect(planAutoAddresses({ candidates: [stamped], base: BASE, takenHosts: [`web-shop.${BASE}`] })).toEqual([]);
    expect(planAutoAddresses({ candidates: [cand({ routeHosts: ['shop.acme.com'] })], base: BASE, takenHosts: [] })).toEqual([]);
    const removed = cand({ labels: { [AUTO_ADDRESS_HOST_LABEL]: `web-shop.${BASE}` }, routeHosts: [] });
    expect(planAutoAddresses({ candidates: [removed], base: BASE, takenHosts: [] })).toEqual([]);
  });
  it('re-hosts when the edge IP changes', () => {
    const stamped = cand({ labels: { [AUTO_ADDRESS_HOST_LABEL]: `web-shop.${BASE}` }, routeHosts: [`web-shop.${BASE}`] });
    expect(planAutoAddresses({ candidates: [stamped], base: '198-51-100-7.sslip.io', takenHosts: [] })).toEqual([
      { kind: 'rehost', serviceId: 'id-web', serviceName: 'shop_web', host: 'web-shop.198-51-100-7.sslip.io', previousHost: `web-shop.${BASE}` },
    ]);
  });
  it('collisions get a stable hash suffix', () => {
    const a = cand({ serviceId: 'a', serviceName: 'shop_web', stack: 'shop' });
    const b = cand({ serviceId: 'b', serviceName: 'web-shop', stack: '(ungrouped)' });
    const plan = planAutoAddresses({ candidates: [a, b], base: BASE, takenHosts: [] });
    expect(plan.map((x) => x.host)[0]).toBe(`web-shop.${BASE}`);
    expect(plan[1]!.host).toMatch(new RegExp(`^web-shop-[a-z0-9]{6}\\.${BASE.replace(/\./g, '\\.')}$`));
    expect(planAutoAddresses({ candidates: [b, a], base: BASE, takenHosts: [] })).toEqual(plan);
  });
  it('no base (no edge IP / tunnel) → nothing', () => {
    expect(planAutoAddresses({ candidates: [cand()], base: null, takenHosts: [] })).toEqual([]);
  });
});
