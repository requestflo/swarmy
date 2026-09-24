import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REGISTRY_FIREWALL_CHAIN,
  parseAllowCidrs,
  parseFirewallOutput,
  renderRegistryFirewallScript,
} from './registry-firewall';

/**
 * A fake `iptables` backend: a tiny in-file rule store, enough to run the real
 * script under `sh` and assert the rules it converges to. `DOCKER-INGRESS`
 * publishes whatever ports `INGRESS_PORTS` lists.
 */
function fakeIptables(dir: string, ingressPorts: number[]): string {
  const bin = path.join(dir, 'bin');
  Bun.spawnSync(['mkdir', '-p', bin]);
  const store = path.join(dir, 'rules');
  writeFileSync(store, '');
  const stub = `#!/bin/sh
store="${store}"
[ "$1" = "-w" ] && shift
echo "$*" >> "${dir}/calls"
case "$*" in
  "-t filter -S DOCKER-USER") echo "-N DOCKER-USER"; exit 0 ;;
  "-t nat -S DOCKER-INGRESS") ${ingressPorts.map((p) => `echo "-A DOCKER-INGRESS -p tcp -m tcp --dport ${p} -j DNAT --to-destination 172.18.0.2:${p}";`).join(' ')} exit 0 ;;
esac
cmd="$1"; shift
chain="$1"; shift
case "$cmd" in
  -S) grep "^-A $chain " "$store"; exit 0 ;;
  -N) exit 0 ;;
  -F) grep -v "^-A $chain " "$store" > "$store.tmp"; mv "$store.tmp" "$store"; exit 0 ;;
  -A) echo "-A $chain $*" >> "$store"; exit 0 ;;
  -I) [ "$1" = "1" ] && shift; echo "-A $chain $*" >> "$store"; exit 0 ;;
  -C) grep -qxF -- "-A $chain $*" "$store"; exit $? ;;
esac
exit 1
`;
  const p = path.join(bin, 'iptables-legacy');
  writeFileSync(p, stub);
  chmodSync(p, 0o755);
  return bin;
}

function runScript(script: string, bin: string): { out: string; code: number } {
  const r = Bun.spawnSync(['sh', '-c', script], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { out: r.stdout.toString() + r.stderr.toString(), code: r.exitCode ?? -1 };
}

describe('registry firewall floor (:5000 registry / :5001 pull-through cache never reachable from outside)', () => {
  it('drops forwarded traffic to published registry ports, keeps local bridges, jumps from DOCKER-USER', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-regfw-'));
    const bin = fakeIptables(dir, [5000, 5001, 443]);
    const r = runScript(renderRegistryFirewallScript({ allowCidrs: ['100.64.0.0/10'] }), bin);
    expect(r.code).toBe(0);
    expect(r.out).toContain('swarmy-registry-firewall: applied (iptables-legacy)');
    const rules = readFileSync(path.join(dir, 'rules'), 'utf8').trim().split('\n');
    const C = REGISTRY_FIREWALL_CHAIN;
    expect(rules).toEqual([
      `-A ${C} -s 100.64.0.0/10 -j RETURN`,
      `-A ${C} -i docker0 -j RETURN`,
      `-A ${C} -i br-+ -j RETURN`,
      `-A ${C} -p tcp -m conntrack --ctorigdstport 5000 --ctdir ORIGINAL -j DROP`,
      `-A ${C} -p tcp -m conntrack --ctorigdstport 5001 --ctdir ORIGINAL -j DROP`,
      `-A DOCKER-USER -j ${C}`,
    ]);
    // Second pass is a no-op (no flush window every tick).
    const again = runScript(renderRegistryFirewallScript({ allowCidrs: ['100.64.0.0/10'] }), bin);
    expect(again.out).toContain('swarmy-registry-firewall: unchanged (iptables-legacy)');
    expect(readFileSync(path.join(dir, 'rules'), 'utf8').trim().split('\n')).toHaveLength(6);
  });

  it('only drops ports the swarm ingress actually publishes (no registry → no DROP rule)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-regfw-'));
    const bin = fakeIptables(dir, [5001]);
    runScript(renderRegistryFirewallScript(), bin);
    const rules = readFileSync(path.join(dir, 'rules'), 'utf8');
    expect(rules).toContain('--ctorigdstport 5001');
    expect(rules).not.toContain('--ctorigdstport 5000');
  });

  it('reconverges when the allowlist changes (stale rules are flushed)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-regfw-'));
    const bin = fakeIptables(dir, [5000]);
    runScript(renderRegistryFirewallScript({ allowCidrs: ['10.0.0.0/8'] }), bin);
    const r = runScript(renderRegistryFirewallScript(), bin);
    expect(r.out).toContain('applied');
    expect(readFileSync(path.join(dir, 'rules'), 'utf8')).not.toContain('10.0.0.0/8');
  });

  it('reports unsupported when no backend has DOCKER-USER', () => {
    const r = runScript(renderRegistryFirewallScript(), mkdtempSync(path.join(tmpdir(), 'swarmy-regfw-empty-')));
    expect(r.out).toContain('unsupported');
    expect(parseFirewallOutput(r.out, r.code)).toBe('unsupported');
  });

  it('never lets an allowlist entry reach the shell unless it is a strict IPv4 CIDR', () => {
    expect(parseAllowCidrs('10.0.0.0/8, 100.64.0.0/10 1.2.3.4')).toEqual(['10.0.0.0/8', '100.64.0.0/10', '1.2.3.4']);
    expect(parseAllowCidrs('10.0.0.0/8;reboot $(id) 0.0.0.0/33 999.1.1.1')).toEqual([]);
    const s = renderRegistryFirewallScript({ allowCidrs: ['1.2.3.4/32', '$(reboot)'], ports: [5000, 70000, 1.5] });
    expect(s).not.toContain('reboot');
    expect(s).toContain('for p in 5000;');
  });

  it('parses statuses', () => {
    expect(parseFirewallOutput('swarmy-registry-firewall: applied (iptables)\n', 0)).toBe('applied');
    expect(parseFirewallOutput('swarmy-registry-firewall: unchanged (iptables)\n', 0)).toBe('unchanged');
    expect(parseFirewallOutput('iptables: Permission denied\n', 4)).toBe('failed');
  });
});
