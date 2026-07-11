import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  ALLOW_EXEC: (process.env.SWARMY_ALLOW_EXEC ?? 'false') === 'true',
  // Node shell (host RCE) is strictly more dangerous than container exec and
  // must NEVER ride the same flag. Default-off; epic #11 Phase 2.
  ALLOW_NODE_SHELL: (process.env.SWARMY_ALLOW_NODE_SHELL ?? 'false') === 'true',
  // Hard per-session output cap (bytes) — `yes`-bomb / runaway-output guard.
  // 0 disables the cap. Default 64 MiB.
  TERM_MAX_OUTPUT_BYTES: Number(process.env.SWARMY_TERM_MAX_OUTPUT_BYTES ?? 64 * 1024 * 1024),
  // Mesh provisioning is on by default; a node can opt out (epic #6).
  ALLOW_MESH: (process.env.SWARMY_ALLOW_MESH ?? 'true') === 'true',
  ALLOW_BUILD: (process.env.SWARMY_ALLOW_BUILD ?? 'false') === 'true',
  // Mesh-first join (epic: zero-trust-networking): when a setup key is
  // present, the agent joins NetBird and confirms connectivity BEFORE
  // registering, so swarm formation can advertise the mesh IP. Empty by
  // default — dormant, no behavior change for orgs without mesh enabled.
  MESH_SETUP_KEY: process.env.SWARMY_MESH_SETUP_KEY ?? '',
  MESH_MANAGEMENT_URL: process.env.SWARMY_MESH_MANAGEMENT_URL ?? '',
  MESH_DRIVER: process.env.SWARMY_MESH_DRIVER ?? 'netbird',
};
