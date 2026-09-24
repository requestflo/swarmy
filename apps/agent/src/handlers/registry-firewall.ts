/**
 * Registry firewall floor: the built-in registry (:5000, htpasswd) and the
 * Docker Hub pull-through cache (:5001, NO login — dockerd's
 * `registry-mirrors` sends no creds) are published on the swarm routing mesh,
 * which listens on EVERY interface of EVERY node. Swarm cannot bind a
 * published port to loopback, so without a firewall the cache is an open
 * Docker Hub proxy on each node's public IP (disk fill, bandwidth, the node's
 * Hub rate limit) and the registry's login prompt faces the internet.
 *
 * Nodes only ever need these ports on `localhost` (dockerd pulls, the
 * host-network builder push, trivy/cosign `runOnce`), and loopback traffic
 * never traverses FORWARD. External traffic to a routing-mesh port is DNATed
 * in PREROUTING and then FORWARDed, where Docker consults `DOCKER-USER` first.
 * So the agent keeps a `SWARMY-REGISTRY` chain jumped from `DOCKER-USER` that
 * drops forwarded connections whose ORIGINAL destination port is a registry
 * port — except from local docker bridges (containers on this box) and any
 * operator allowlist (`SWARMY_REGISTRY_FIREWALL_ALLOW`, e.g. the mesh CIDR).
 * Cross-node routing-mesh hops ride the ingress VXLAN (udp/4789), not FORWARD
 * on the task's node, so they are unaffected.
 *
 * The agent re-asserts the floor at start and every few minutes (iptables
 * rules do not survive a reboot; this does). Only ports actually published on
 * the swarm ingress are dropped, so a node without the registry is untouched.
 * `SWARMY_REGISTRY_FIREWALL=false` opts a node out.
 *
 * Applying: the native (systemd) agent runs the script on the host; the
 * container agent runs it in a one-shot `--network host --cap-add NET_ADMIN`
 * container of its own image (which ships iptables). The script picks every
 * iptables backend (legacy / nft) that has Docker's `DOCKER-USER` chain.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import type { DockerClient } from '@swarmy/core/docker';

export const REGISTRY_FIREWALL_CHAIN = 'SWARMY-REGISTRY';
/** :5000 = built-in registry, :5001 = Docker Hub pull-through cache. */
export const REGISTRY_FIREWALL_PORTS = [5000, 5001] as const;
export const REGISTRY_FIREWALL_INTERVAL_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 30_000;

const IPV4_CIDR = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;

/** Parse `SWARMY_REGISTRY_FIREWALL_ALLOW` (comma/space separated IPv4 CIDRs). Invalid entries are dropped. */
export function parseAllowCidrs(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,]+/).filter((s) => IPV4_CIDR.test(s)))];
}

export interface RegistryFirewallOptions {
  ports?: readonly number[];
  allowCidrs?: readonly string[];
}

/**
 * Pure: the idempotent POSIX-sh script that converges the floor. Inputs are
 * validated (integer ports, strict CIDR regex) so nothing user-shaped reaches
 * the shell. Prints one `swarmy-registry-firewall: <status>` line per backend
 * (`applied` | `unchanged`), or `unsupported` when no backend has DOCKER-USER.
 */
export function renderRegistryFirewallScript(opts: RegistryFirewallOptions = {}): string {
  const ports = (opts.ports ?? REGISTRY_FIREWALL_PORTS).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  const cidrs = (opts.allowCidrs ?? []).filter((c) => IPV4_CIDR.test(c));
  const C = REGISTRY_FIREWALL_CHAIN;
  return `set -u
C=${C}
found=0
for ipt in iptables-legacy iptables-nft iptables; do
  command -v "$ipt" >/dev/null 2>&1 || continue
  "$ipt" -w -t filter -S DOCKER-USER >/dev/null 2>&1 || continue
  found=1
  # Desired rules (one per line); only ports the swarm ingress publishes.
  rules="${cidrs.map((c) => `-s ${c} -j RETURN`).join('\n')}
-i docker0 -j RETURN
-i br-+ -j RETURN"
  ingress="$("$ipt" -w -t nat -S DOCKER-INGRESS 2>/dev/null || true)"
  for p in ${ports.join(' ')}; do
    if printf '%s\\n' "$ingress" | grep -q -- "--dport $p "; then
      rules="$rules
-p tcp -m conntrack --ctorigdstport $p --ctdir ORIGINAL -j DROP"
    fi
  done
  want=$(printf '%s\\n' "$rules" | grep -c .)
  have=$("$ipt" -w -S "$C" 2>/dev/null | grep -c '^-A' || true)
  ok=1
  [ "$want" = "$have" ] || ok=0
  if [ "$ok" = 1 ]; then
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      # shellcheck disable=SC2086
      "$ipt" -w -C "$C" $r >/dev/null 2>&1 || { ok=0; break; }
    done <<EOF
$rules
EOF
  fi
  "$ipt" -w -C DOCKER-USER -j "$C" >/dev/null 2>&1 || ok=0
  if [ "$ok" = 1 ]; then echo "swarmy-registry-firewall: unchanged ($ipt)"; continue; fi
  "$ipt" -w -N "$C" >/dev/null 2>&1 || true
  "$ipt" -w -F "$C"
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    # shellcheck disable=SC2086
    "$ipt" -w -A "$C" $r
  done <<EOF
$rules
EOF
  "$ipt" -w -C DOCKER-USER -j "$C" >/dev/null 2>&1 || "$ipt" -w -I DOCKER-USER 1 -j "$C"
  echo "swarmy-registry-firewall: applied ($ipt)"
done
[ "$found" = 1 ] || echo "swarmy-registry-firewall: unsupported (no DOCKER-USER chain)"
`;
}

export type RegistryFirewallStatus = 'applied' | 'unchanged' | 'unsupported' | 'skipped' | 'failed';

/** Pure: fold the script's output into one status. */
export function parseFirewallOutput(output: string, exitCode: number): RegistryFirewallStatus {
  if (/swarmy-registry-firewall: applied/.test(output)) return exitCode === 0 ? 'applied' : 'failed';
  if (/swarmy-registry-firewall: unchanged/.test(output)) return exitCode === 0 ? 'unchanged' : 'failed';
  if (/swarmy-registry-firewall: unsupported/.test(output)) return 'unsupported';
  return 'failed';
}

async function runNative(script: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, output: `${out}${err}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Container agent: a one-shot host-network NET_ADMIN container of our own image. */
async function runInSidecar(docker: DockerClient, script: string): Promise<{ exitCode: number; output: string }> {
  const d = docker.docker;
  const self = (await d.getContainer(os.hostname()).inspect()) as { Image?: string };
  if (!self.Image) throw new Error('cannot resolve the agent image');
  const c = await d.createContainer({
    Image: self.Image,
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [script],
    Labels: { 'swarmy.managed': 'true', 'swarmy.registry.firewall': 'true' },
    HostConfig: { NetworkMode: 'host', CapAdd: ['NET_ADMIN', 'NET_RAW'], AutoRemove: false },
    Tty: true,
  });
  const timer = setTimeout(() => void c.kill().catch(() => undefined), RUN_TIMEOUT_MS);
  try {
    await c.start();
    const status = (await c.wait()) as { StatusCode?: number };
    const logs = await c.logs({ stdout: true, stderr: true });
    return { exitCode: status.StatusCode ?? 1, output: logs.toString('utf8') };
  } finally {
    clearTimeout(timer);
    await c.remove({ force: true }).catch(() => undefined);
  }
}

/** Converge the floor on this node. Never throws. */
export async function enforceRegistryFirewall(
  docker: DockerClient,
  opts: RegistryFirewallOptions & { enabled: boolean; packaging: 'binary' | 'container' },
): Promise<{ status: RegistryFirewallStatus; detail?: string }> {
  if (!opts.enabled || process.platform !== 'linux') return { status: 'skipped' };
  const script = renderRegistryFirewallScript(opts);
  try {
    // A containerised agent can't touch host netfilter; an interpreted agent on
    // the host (dev/`bun run`) runs natively like the compiled binary.
    const inContainer = opts.packaging === 'container' && existsSync('/.dockerenv');
    if (!inContainer && process.getuid?.() !== 0) return { status: 'skipped', detail: 'not root' };
    const r = inContainer ? await runInSidecar(docker, script) : await runNative(script);
    const status = parseFirewallOutput(r.output, r.exitCode);
    return status === 'failed' ? { status, detail: r.output.trim().slice(-400) } : { status };
  } catch (e) {
    return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}
