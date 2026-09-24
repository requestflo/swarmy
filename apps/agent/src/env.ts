import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBuildOverride, parseCapabilityOverride, parsePublicIpEcho } from '@swarmy/core';

/**
 * Fallback env bootstrap: interactive CLI invocations (`swarmy-agent status`
 * over SSH) don't inherit systemd's EnvironmentFile, so load it here — in the
 * ONE module that reads process.env — before anything is captured. This must
 * live in env.ts (not the entrypoint): the compiled bundle's module
 * evaluation order would otherwise race it. Real environment always wins
 * (systemd/docker-set vars are never overridden); missing file is a no-op
 * (dev machines, container backend).
 */
function loadAgentEnvFile(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadAgentEnvFile(process.env.SWARMY_AGENT_ENV_FILE ?? '/etc/swarmy/agent.env');

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

const statePath = expandHome(process.env.SWARMY_AGENT_STATE ?? '~/.swarmy/agent.json');

export const env = {
  AGENT_WS_URL: process.env.AGENT_WS_URL ?? 'ws://localhost:3021/agent/ws',
  JOIN_TOKEN: process.env.SWARMY_JOIN_TOKEN ?? '',
  DOCKER_SOCKET: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  STATE_PATH: statePath,
  // Local CLI↔daemon channel (swarmy-agent status/doctor/reconnect). Lives next
  // to the state file so prod lands in /var/lib/swarmy (root 0600) and dev in
  // ~/.swarmy — no /run handling, no network listener, ever.
  SOCKET_PATH: expandHome(process.env.SWARMY_AGENT_SOCK ?? path.join(path.dirname(statePath), 'agent.sock')),
  // Container exec is DEFAULT-ON: the controller-side ABAC `terminal.open` +
  // TerminalPolicy + audit + recording are the real gate. SWARMY_ALLOW_EXEC is
  // a tri-state local override: `false` vetoes exec on this box, `true` forces
  // it on over the `swarmy.node.exec=false` label, unset defers to the label
  // (absent label = allowed). See execGateAllows in @swarmy/core.
  EXEC_OVERRIDE: parseCapabilityOverride(process.env.SWARMY_ALLOW_EXEC),
  // Node shell (host RCE) is strictly more dangerous than container exec and
  // must NEVER ride the same flag. DEFAULT-OFF: only the admin-toggled
  // `swarmy.node.shell=true` label (asserted by the controller per session)
  // enables it; SWARMY_ALLOW_NODE_SHELL=false vetoes it locally, `true` does
  // not force it on. See nodeShellGateAllows in @swarmy/core.
  SHELL_OVERRIDE: parseCapabilityOverride(process.env.SWARMY_ALLOW_NODE_SHELL),
  // Hard per-session output cap (bytes) — `yes`-bomb / runaway-output guard.
  // 0 disables the cap. Default 64 MiB.
  TERM_MAX_OUTPUT_BYTES: Number(process.env.SWARMY_TERM_MAX_OUTPUT_BYTES ?? 64 * 1024 * 1024),
  // Mesh provisioning is on by default; a node can opt out (epic #6).
  ALLOW_MESH: (process.env.SWARMY_ALLOW_MESH ?? 'true') === 'true',
  // Disk hygiene (periodic prune of stopped one-shots / unused images / build
  // cache) is on by default; SWARMY_ALLOW_HYGIENE=false vetoes it on this node.
  ALLOW_HYGIENE: (process.env.SWARMY_ALLOW_HYGIENE ?? 'true') !== 'false',
  // Builds/image-GC are a node CAPABILITY managed from the dashboard (the
  // `swarmy.node.builder` role label, asserted by the controller per command).
  // SWARMY_ALLOW_BUILD stays as an explicit local override: `true` forces
  // builds on, `false` vetoes them even when the role is on, unset defers to
  // the role. See buildGateAllows in @swarmy/core.
  BUILD_OVERRIDE: parseBuildOverride(process.env.SWARMY_ALLOW_BUILD),
  // Mesh-first join (epic: zero-trust-networking): when a setup key is
  // present, the agent joins NetBird and confirms connectivity BEFORE
  // registering, so swarm formation can advertise the mesh IP. Empty by
  // default — dormant, no behavior change for orgs without mesh enabled.
  MESH_SETUP_KEY: process.env.SWARMY_MESH_SETUP_KEY ?? '',
  MESH_MANAGEMENT_URL: process.env.SWARMY_MESH_MANAGEMENT_URL ?? '',
  MESH_DRIVER: process.env.SWARMY_MESH_DRIVER ?? 'netbird',
  /**
   * Third-party IP-echo URLs, used ONLY when the controller did not see a
   * public source address for this node (plans/self-reliance.md B8). Unset →
   * the built-in defaults; empty / `off` → never call out.
   */
  PUBLIC_IP_ECHO: parsePublicIpEcho(process.env.SWARMY_PUBLIC_IP_ECHO),
  /**
   * Registry firewall floor (handlers/registry-firewall.ts): the agent keeps
   * DOCKER-USER rules so the routing-mesh registry (:5000) and pull-through
   * cache (:5001) answer only on this node's loopback. ON by default;
   * `SWARMY_REGISTRY_FIREWALL=false` opts the node out. Extra IPv4 CIDRs that
   * may reach them (e.g. a mesh range) go in SWARMY_REGISTRY_FIREWALL_ALLOW.
   */
  REGISTRY_FIREWALL: (process.env.SWARMY_REGISTRY_FIREWALL ?? 'true') !== 'false',
  REGISTRY_FIREWALL_ALLOW: process.env.SWARMY_REGISTRY_FIREWALL_ALLOW ?? '',
};
