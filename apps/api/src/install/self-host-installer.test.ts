import { describe, expect, it } from 'bun:test';
import path from 'node:path';

// scripts/install-swarmy.sh only defines functions when SOURCED (it runs `main`
// when executed or piped), so its pure helpers are testable via `bash -c`.
const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

function sh(expr: string): { out: string; code: number } {
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; ${expr}`, SCRIPT], { stdout: 'pipe', stderr: 'pipe' });
  return { out: r.stdout.toString(), code: r.exitCode ?? -1 };
}

describe('install-swarmy.sh https dashboard domain', () => {
  it('sourcing does not run the installer', () => {
    expect(sh('echo sourced')).toEqual({ out: 'sourced\n', code: 0 });
  });

  it('sslip_domain dashes an IPv4 into swarmy.<a-b-c-d>.sslip.io', () => {
    expect(sh('sslip_domain 46.101.22.121').out).toBe('swarmy.46-101-22-121.sslip.io');
    expect(sh('sslip_domain 999.1.1.1').code).not.toBe(0);
    expect(sh('sslip_domain 2001:db8::1').code).not.toBe(0);
    expect(sh('sslip_domain ""').code).not.toBe(0);
  });

  it('public-IP box (bound), no --domain → sslip.io default', () => {
    expect(sh('dashboard_domain bound 46.101.22.121 "" 0 none').out).toBe('swarmy.46-101-22-121.sslip.io');
  });

  it('--domain overrides (lower-cased), even behind NAT', () => {
    expect(sh('dashboard_domain bound 46.101.22.121 Swarmy.Example.com 0 caddy').out).toBe('swarmy.example.com');
    expect(sh('dashboard_domain nat 46.101.22.121 swarmy.example.com 0 none').out).toBe('swarmy.example.com');
  });

  it('--no-https opts out; NAT/CGNAT/unknown keep the LAN http login', () => {
    expect(sh('dashboard_domain bound 46.101.22.121 "" 1 none').out).toBe('');
    expect(sh('dashboard_domain bound 46.101.22.121 swarmy.example.com 1 none').out).toBe('');
    for (const v of ['nat', 'cgnat', 'unknown']) {
      expect(sh(`dashboard_domain ${v} 46.101.22.121 "" 0 none`).out).toBe('');
    }
  });

  it('a Cloudflare Tunnel fronts the dashboard itself (no Caddy vhost)', () => {
    expect(sh('dashboard_domain bound 46.101.22.121 "" 0 cloudflare').out).toBe('');
  });

  it('bound but no public IP detected → nothing (never a bogus domain)', () => {
    const r = sh('dashboard_domain bound "" "" 0 none');
    expect(r).toEqual({ out: '', code: 0 });
  });
});
