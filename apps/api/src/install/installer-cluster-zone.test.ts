import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// B2(b): `--zone` names the cluster zone. The installer validates it, prints
// the NS + glue records, remembers it, and hands it to the controller, whose
// bootstrap seeds the zone (apps/api/src/bootstrap/cluster-zone.ts).
const ROOT = path.resolve(import.meta.dir, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/install-swarmy.sh');
const STACK = path.join(ROOT, 'deploy/swarmy.lite.stack.yml');

function sh(expr: string, env: Record<string, string> = {}): { out: string; err: string; code: number } {
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; ${expr}`, SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}

describe('install-swarmy.sh --zone', () => {
  it('cluster_zone_value lowercases, drops the trailing dot, and refuses non-names', () => {
    expect(sh('cluster_zone_value Apps.Example.COM.').out).toBe('apps.example.com');
    expect(sh('cluster_zone_value ""')).toMatchObject({ out: '', code: 0 });
    expect(sh('cluster_zone_value localhost').code).not.toBe(0);
    expect(sh('cluster_zone_value "apps example.com"').code).not.toBe(0);
    expect(sh('cluster_zone_value -bad.example.com').code).not.toBe(0);
  }, 30_000);

  it('zone_glue prints the NS + glue the registrar needs, this box as ns1', () => {
    expect(sh('zone_glue apps.example.com 5.9.10.200').out).toBe(
      [
        'apps.example.com.  NS  ns1.apps.example.com.',
        'apps.example.com.  NS  ns2.apps.example.com.',
        'ns1.apps.example.com.  A  5.9.10.200',
        'ns2.apps.example.com.  A  <public IPv4 of your second front door>',
        '',
      ].join('\n'),
    );
    expect(sh('zone_glue apps.example.com ""').out).toContain('ns1.apps.example.com.  A  <public IPv4 of this server>');
  }, 30_000);

  it('env is read and normalised; a bad zone refuses before anything runs', () => {
    expect(sh('printf %s "$ZONE"', { SWARMY_CLUSTER_ZONE: 'Apps.Example.com' }).out).toBe('apps.example.com');
    const bad = sh('echo unreachable', { SWARMY_CLUSTER_ZONE: 'not a zone' });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('--zone / SWARMY_CLUSTER_ZONE must be a DNS name');
  }, 30_000);

  it('configure_zone prints the glue only when a zone is set', () => {
    const on = sh('ZONE=apps.example.com PUBLIC_IP=5.9.10.200 DASHBOARD_DOMAIN=swarmy.5-9-10-200.sslip.io; configure_zone');
    expect(on.out).toContain('ns1.apps.example.com.  A  5.9.10.200');
    expect(on.out).toContain('--domain swarmy.5-9-10-200.apps.example.com');
    expect(sh('ZONE=; configure_zone')).toMatchObject({ out: '', code: 0 });
  }, 30_000);

  it('the flag exists, is remembered across re-runs, and reaches the controller', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('--zone) ZONE="${2:?}"; EXPLICIT="${EXPLICIT}ZONE "; shift ;;');
    expect(script).toMatch(/for v in [^;]* ZONE [^;]*; do\n\s+eval "saved=/);
    expect(script).toContain('SWARMY_CLUSTER_ZONE="$ZONE" \\');
    expect(script).toMatch(/configure_mesh\n\s+configure_zone\n/);
    expect(readFileSync(STACK, 'utf8')).toContain('SWARMY_CLUSTER_ZONE: ${SWARMY_CLUSTER_ZONE:-}');
  });
});
