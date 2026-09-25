/**
 * Host firewall floor for the self-hosted mesh control plane (QA-014).
 *
 * `netbird-server` runs on the host network and opens ports nobody outside the
 * host needs: Prometheus metrics (:9090, always every interface), the legacy
 * gRPC port (:33073, always every interface) and health (:9000, bound to
 * loopback by our config, dropped here too as a floor). This converges one
 * INPUT-chain jump to `SWARMY-MESH-CTL`, which RETURNs traffic from loopback,
 * Docker bridges and the mesh interface and DROPs those ports from anywhere
 * else. The public ports (:443 / :8081 / :3478) are never touched.
 *
 * Same runner as the registry floor (registry-firewall.ts): natively on a
 * binary agent, in a one-shot host-network NET_ADMIN container of our own
 * image for the container agent. Idempotent; never throws.
 */
import { existsSync } from 'node:fs';
import type { DockerClient } from '@swarmy/core/docker';
import { runFirewallScript } from './registry-firewall';

export const MESH_FIREWALL_CHAIN = 'SWARMY-MESH-CTL';
export const MESH_FIREWALL_PORTS = [9000, 9090, 33073] as const;

/** Pure: the idempotent POSIX-sh script. Ports are validated integers. */
export function renderMeshFirewallScript(ports: readonly number[] = MESH_FIREWALL_PORTS): string {
  const ps = ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536).join(',');
  const C = MESH_FIREWALL_CHAIN;
  return `set -u
C=${C}
found=0
rules="-i lo -j RETURN
-i docker0 -j RETURN
-i docker_gwbridge -j RETURN
-i br-+ -j RETURN
-i wt0 -j RETURN
-p tcp -m multiport --dports ${ps} -j DROP"
for ipt in iptables-legacy iptables-nft iptables; do
  command -v "$ipt" >/dev/null 2>&1 || continue
  "$ipt" -w -t filter -S INPUT >/dev/null 2>&1 || continue
  # Only the backend the kernel actually uses has Docker's chains.
  "$ipt" -w -t filter -S DOCKER-USER >/dev/null 2>&1 || continue
  found=1
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
  "$ipt" -w -C INPUT -j "$C" >/dev/null 2>&1 || ok=0
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
  "$ipt" -w -C INPUT -j "$C" >/dev/null 2>&1 || "$ipt" -w -I INPUT 1 -j "$C"
  echo "swarmy-registry-firewall: applied ($ipt)"
done
[ "$found" = 1 ] || echo "swarmy-registry-firewall: unsupported (no DOCKER-USER chain)"
`;
}

/** Converge the floor on the control-plane node. Never throws. */
export async function enforceMeshFirewall(
  docker: DockerClient,
  packaging: 'binary' | 'container',
): Promise<{ status: string; detail?: string }> {
  if (process.platform !== 'linux') return { status: 'skipped' };
  const inContainer = packaging === 'container' && existsSync('/.dockerenv');
  if (!inContainer && process.getuid?.() !== 0) return { status: 'skipped', detail: 'not root' };
  return runFirewallScript(docker, renderMeshFirewallScript(), inContainer);
}
