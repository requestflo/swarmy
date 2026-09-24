import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
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

// Secrets hygiene: state.env holds the vault key, auth secret, admin password,
// swarm manager token and NetBird PAT; join/setup keys must never be `docker
// run -e` (they would persist in `docker inspect`).
describe('install-swarmy.sh secret handling', () => {
  const script = readFileSync(SCRIPT, 'utf8');

  it('sets umask 077 before anything is written', () => {
    expect(script).toMatch(/^umask 077$/m);
  });

  it('state_set keeps the dir 0700 and state.env 0600 with no stray temp file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-state-'));
    try {
      const st = `${dir}/install`;
      const r = sh(
        `STATE_DIR=${st}; STATE_FILE=${st}/state.env; state_set A 1; state_set B 'x y'; state_set A 2; ` +
          `stat -c '%a' ${st} ${st}/state.env 2>/dev/null || stat -f '%Lp' ${st} ${st}/state.env; ls -A ${st}; cat ${st}/state.env`,
      );
      expect(r.code).toBe(0);
      expect(r.out).toBe("700\n600\nstate.env\nB=x\\ y\nA=2\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no join token or setup key on a docker run -e (or the PAT on curl argv)', () => {
    expect(script).not.toMatch(/-e\s+SWARMY_JOIN_TOKEN=/);
    expect(script).not.toMatch(/-e\s+NB_SETUP_KEY=/);
    expect(script).not.toMatch(/-H\s+"Authorization: Token/);
    expect(script).toContain('-v "$AGENT_ENV_FILE":/etc/swarmy/agent.env:ro');
    expect(script).toContain('NB_SETUP_KEY_FILE=/etc/netbird/setup-key');
  });

  it('daemon.json writers run under umask 022 (stays 0644)', () => {
    expect(script).toContain('with_public_umask ensure_docker_log_opts');
    expect(script).toContain('with_public_umask ensure_docker_registry_mirror');
  });
});

describe('install-swarmy.sh --mesh swarmy helpers', () => {
  it('mesh_domain: explicit wins, then mesh.<dashboard>, then mesh-<ip>.sslip.io', () => {
    expect(sh('mesh_domain Mesh.Example.com swarmy.example.com 1.2.3.4').out).toBe('mesh.example.com');
    expect(sh('mesh_domain "" swarmy.46-101-22-121.sslip.io 46.101.22.121').out).toBe('mesh.swarmy.46-101-22-121.sslip.io');
    expect(sh('mesh_domain "" "" 192.168.64.5').out).toBe('mesh-192-168-64-5.sslip.io');
    expect(sh('mesh_domain "" "" ""').code).not.toBe(0);
  });

  it('mesh_tls_mode: edge behind Caddy, letsencrypt on a bare public box, none on a LAN', () => {
    expect(sh('mesh_tls_mode "" caddy swarmy.example.com bound').out).toBe('edge');
    expect(sh('mesh_tls_mode "" none "" bound').out).toBe('letsencrypt');
    expect(sh('mesh_tls_mode "" none "" nat').out).toBe('none');
    expect(sh('mesh_tls_mode letsencrypt caddy swarmy.example.com bound').out).toBe('letsencrypt');
  });

  it('mesh_public_url follows the TLS mode', () => {
    expect(sh('mesh_public_url mesh.x none').out).toBe('http://mesh.x:8081');
    expect(sh('mesh_public_url mesh.x edge').out).toBe('https://mesh.x');
  });

  it('mesh_addr_pool is stable per seed, 10.200–249 and never 10.0', () => {
    const a = sh('mesh_addr_pool mesh.example.com').out;
    expect(a).toMatch(/^10\.2[0-4]\d\.0\.0\/16$/);
    expect(sh('mesh_addr_pool mesh.example.com').out).toBe(a);
  });

  it('mesh_control_config is JSON the combined server reads, with no default-policy key', () => {
    const r = sh('mesh_control_config mesh.x none :8081 relay-secret-0123456789 MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=');
    const doc = JSON.parse(r.out.split('\n').slice(1).join('\n'));
    expect(doc.server.exposedAddress).toBe('http://mesh.x:8081');
    expect(doc.server.auth.issuer).toBe('http://mesh.x:8081/oauth2');
    expect(doc.server.listenAddress).toBe(':8081');
    expect(doc.server.store.engine).toBe('sqlite');
    expect('disableDefaultPolicy' in doc.server).toBe(false);
    const le = JSON.parse(sh('mesh_control_config mesh.x letsencrypt :443 s k').out.split('\n').slice(1).join('\n'));
    expect(le.server.tls.letsencrypt.domains).toEqual(['mesh.x']);
    expect(le.server.exposedAddress).toBe('https://mesh.x:443');
  });
});
