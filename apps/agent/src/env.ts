import os from 'node:os';
import path from 'node:path';

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export const env = {
  AGENT_WS_URL: process.env.AGENT_WS_URL ?? 'ws://localhost:3001/agent/ws',
  JOIN_TOKEN: process.env.SWARMY_JOIN_TOKEN ?? '',
  DOCKER_SOCKET: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  STATE_PATH: expandHome(process.env.SWARMY_AGENT_STATE ?? '~/.swarmy/agent.json'),
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
};
