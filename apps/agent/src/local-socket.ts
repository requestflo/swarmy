/**
 * Local diagnostics socket — the CLI↔daemon channel.
 *
 * `swarmy-agent status|doctor|reconnect` talk to the RUNNING daemon here, so
 * diagnostics reflect live state (WS connectivity, last auth rejection,
 * session persistence) without opening a second controller connection or
 * re-joining the mesh. Unix socket only, mode 0600, owned by the daemon's
 * user (root under systemd): local root-or-owner access, no network listener,
 * ever. When the daemon is down the CLI falls back to direct inspection —
 * which is exactly the situation `doctor` is for.
 */
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export interface DaemonStatus {
  version: string;
  commit: string;
  protocolVersion: number;
  pid: number;
  startedAt: number;
  uptimeSec: number;
  wsUrl: string;
  connected: boolean;
  nodeId: string | null;
  sessionVersion: number | null;
  /** False when the credential exists only in memory — a reboot would orphan the node. */
  sessionPersisted: boolean;
  lastAckAt: number | null;
  lastAuthReject: { code: number; reason: string; at: number } | null;
  hostname: string;
  meshIp: string | null;
  meshConnected: boolean;
  hasJoinToken: boolean;
}

export interface LocalSocketDeps {
  socketPath: string;
  getStatus: () => DaemonStatus;
  reconnect: () => void;
  log: (...args: unknown[]) => void;
}

export interface LocalSocket {
  stop: () => void;
}

export function startLocalSocket(deps: LocalSocketDeps): LocalSocket | null {
  const { socketPath, getStatus, reconnect, log } = deps;
  try {
    mkdirSync(path.dirname(socketPath), { recursive: true });
    // A previous daemon's socket file blocks the bind — it's dead by
    // definition (we're the daemon), so clear it.
    try {
      unlinkSync(socketPath);
    } catch {
      // no stale socket
    }

    const server = Bun.serve({
      unix: socketPath,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/status') {
          return Response.json(getStatus());
        }
        if (req.method === 'POST' && url.pathname === '/reconnect') {
          reconnect();
          return Response.json({ ok: true });
        }
        return new Response('not found', { status: 404 });
      },
    });

    chmodSync(socketPath, 0o600);
    return {
      stop: () => {
        server.stop(true);
        try {
          unlinkSync(socketPath);
        } catch {
          // already gone
        }
      },
    };
  } catch (err) {
    log(`local diagnostics socket unavailable (${err instanceof Error ? err.message : err}) — CLI falls back to direct inspection`);
    return null;
  }
}
