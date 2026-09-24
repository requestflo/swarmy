import { afterEach, describe, expect, it } from 'bun:test';
import {
  adaptDirectHttpRequest,
  directHttpHost,
  servedOrigins,
  setServedHostsProvider,
  trustedOriginsNow,
} from './origins';

const ENV = {
  CONTROLLER_PUBLIC_URL: 'https://swarmy.46-101-22-121.sslip.io',
  BETTER_AUTH_URL: 'https://swarmy.46-101-22-121.sslip.io',
  SWARMY_DIRECT_URL: 'http://46.101.22.121:3021',
  // The installer's host addresses: public, LAN, mesh.
  SWARMY_DIRECT_HOSTS: '46.101.22.121 10.0.0.5 100.92.1.7 127.0.0.1',
  SWARMY_DASHBOARD_DOMAIN: 'swarmy.46-101-22-121.sslip.io',
};

afterEach(() => setServedHostsProvider(() => []));

describe('servedOrigins (QA-001)', () => {
  it('each host gets its http:<port> origin; IPv4 also its sslip names; plus the dashboard domain', () => {
    expect(servedOrigins({ hosts: ['10.0.0.5'], port: 3021, dashboardDomain: 'swarmy.example.com' })).toEqual([
      'http://10.0.0.5:3021',
      'https://swarmy.10-0-0-5.sslip.io',
      'http://swarmy.10-0-0-5.sslip.io:3021',
      'https://swarmy.example.com',
    ]);
  });

  it('never trusts loopback, unspecified, link-local, junk or injection attempts', () => {
    const bad = ['127.0.0.1', '0.0.0.0', '169.254.1.1', '::1', 'fe80::1', '999.1.1.1', 'evil.com/x', 'a b', '*', ''];
    expect(servedOrigins({ hosts: bad, port: 3021 })).toEqual([]);
    expect(servedOrigins({ hosts: ['2001:db8::5'], port: 3021 })).toEqual(['http://[2001:db8::5]:3021']);
  });
});

describe('trustedOriginsNow', () => {
  it('a multi-homed host: every one of its addresses signs in, not just LOGIN_URL', () => {
    const o = trustedOriginsNow(ENV);
    for (const want of [
      'http://46.101.22.121:3021',
      'http://10.0.0.5:3021',
      'http://100.92.1.7:3021',
      'https://swarmy.10-0-0-5.sslip.io',
      'https://swarmy.46-101-22-121.sslip.io',
    ]) {
      expect(o).toContain(want);
    }
    expect(o).not.toContain('http://127.0.0.1:3021');
  });

  it('live node addresses (other nodes publish the port too) join without a restart', () => {
    expect(trustedOriginsNow(ENV)).not.toContain('http://192.168.1.20:3021');
    setServedHostsProvider(() => ['192.168.1.20']);
    expect(trustedOriginsNow(ENV)).toContain('http://192.168.1.20:3021');
  });

  it('an arbitrary origin is never trusted', () => {
    setServedHostsProvider(() => ['192.168.1.20']);
    const o = trustedOriginsNow(ENV);
    expect(o).not.toContain('https://evil.example');
    expect(o.every((x) => !x.includes('*'))).toBe(true);
  });

  it('a throwing provider degrades to the env set', () => {
    setServedHostsProvider(() => {
      throw new Error('hub not ready');
    });
    expect(trustedOriginsNow(ENV)).toContain('http://10.0.0.5:3021');
  });
});

describe('cookie translation follows the served http origins', () => {
  it('sign-in over the LAN address keeps its session (cookies translated there too)', () => {
    const match = directHttpHost(ENV)!;
    expect(match('10.0.0.5:3021')).toBe(true);
    expect(match('evil.example:3021')).toBe(false);
    const req = new Request('http://10.0.0.5:3021/api/trpc/x', {
      headers: { host: '10.0.0.5:3021', cookie: 'swarmy.session_token=abc' },
    });
    expect(adaptDirectHttpRequest(req, match).headers.get('cookie')).toBe('__Secure-swarmy.session_token=abc');
  });
});
