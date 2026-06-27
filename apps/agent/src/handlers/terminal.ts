import { spawn as nodeSpawn } from 'node:child_process';
import type { DockerClient } from '@swarmy/core/docker';
import {
  MAX_TERM_CHUNK_BYTES,
  type TermStartPayload,
  type TermInputPayload,
  type TermResizePayload,
  type TermClosePayload,
} from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';
import { env } from '../env';

/**
 * Interactive terminal (PTY) sessions on the node, multiplexed over the existing
 * agent → controller WebSocket.
 *
 * MVP target = container exec (dockerode), gated by the agent's existing
 * `SWARMY_ALLOW_EXEC`. A degraded node-shell path (a plain child process, no
 * full job control) is included behind the separate, default-off
 * `SWARMY_ALLOW_NODE_SHELL` flag — see env.ts INTEGRATION snippet. (Phase 2
 * upgrades node shell to a real host PTY via node-pty.)
 *
 * Routed from executor.ts: `termStart` → start, `termInput`/`termResize`/
 * `termClose` → the matching live session.
 */

// SWARMY_ALLOW_NODE_SHELL is separate from ALLOW_EXEC; node shell is strictly
// more dangerous and must never ride the container-exec flag. Read directly
// until env.ts is extended (see INTEGRATION).
const ALLOW_NODE_SHELL = (process.env.SWARMY_ALLOW_NODE_SHELL ?? 'false') === 'true';

interface TermSession {
  sessionId: string;
  write: (data: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  kill: (reason: 'killed' | 'idle_timeout' | 'agent_shutdown') => void;
  touch: () => void;
}

const sessions = new Map<string, TermSession>();

/** Split output so no single termData frame exceeds the chunk cap. */
function sendData(conn: AgentConnection, sessionId: string, seqRef: { v: number }, buf: Buffer): void {
  for (let off = 0; off < buf.length; off += MAX_TERM_CHUNK_BYTES) {
    const slice = buf.subarray(off, off + MAX_TERM_CHUNK_BYTES);
    conn.send('termData', {
      sessionId,
      stream: 'stdout',
      seq: seqRef.v++,
      data: slice.toString('base64'),
      encoding: 'base64',
    });
  }
}

export async function handleTermStart(
  docker: DockerClient,
  conn: AgentConnection,
  p: TermStartPayload,
): Promise<void> {
  const { sessionId, target } = p;
  if (sessions.has(sessionId)) return; // already running; ignore duplicate

  try {
    if (target.kind === 'container') {
      if (!env.ALLOW_EXEC) {
        conn.send('termStarted', {
          sessionId,
          ok: false,
          error: { code: 'E_EXEC_DISABLED', message: 'exec disabled on this agent' },
        });
        return;
      }
      await startContainerExec(docker, conn, p, target);
      return;
    }

    // nodeShell
    if (!ALLOW_NODE_SHELL) {
      conn.send('termStarted', {
        sessionId,
        ok: false,
        error: { code: 'E_NODE_SHELL_DISABLED', message: 'node shell disabled on this agent' },
      });
      return;
    }
    startNodeShell(conn, p, target);
  } catch (e) {
    conn.send('termStarted', {
      sessionId,
      ok: false,
      error: { code: 'E_SPAWN', message: e instanceof Error ? e.message : String(e) },
    });
  }
}

async function startContainerExec(
  docker: DockerClient,
  conn: AgentConnection,
  p: TermStartPayload,
  target: Extract<TermTargetKind, { kind: 'container' }>,
): Promise<void> {
  const { sessionId, cols, rows } = p;
  const container = docker.docker.getContainer(target.containerId);

  // Confirm the container exists before we try to exec.
  try {
    await container.inspect();
  } catch {
    conn.send('termStarted', {
      sessionId,
      ok: false,
      error: { code: 'E_NO_SUCH_CONTAINER', message: `no such container ${target.containerId}` },
    });
    return;
  }

  // Probe for a shell when none was requested.
  const candidates: string[][] =
    target.cmd.length > 0 ? [target.cmd] : [['/bin/bash', '-l'], ['/bin/sh']];

  let exec: Awaited<ReturnType<typeof container.exec>> | null = null;
  let lastErr: unknown;
  for (const cmd of candidates) {
    try {
      exec = await container.exec({
        Cmd: cmd,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        User: target.user,
        WorkingDir: target.workdir,
        Env: target.env ? Object.entries(target.env).map(([k, v]) => `${k}=${v}`) : undefined,
      });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!exec) {
    conn.send('termStarted', {
      sessionId,
      ok: false,
      error: {
        code: 'E_NO_SHELL',
        message: lastErr instanceof Error ? lastErr.message : 'no usable shell in image',
      },
    });
    return;
  }

  // hijack:true + stdin:true ⇒ a single duplex stream (Tty merges stdout/stderr).
  const stream = (await exec.start({ hijack: true, stdin: true })) as NodeJS.ReadWriteStream;

  conn.send('termStarted', { sessionId, ok: true });

  const seqRef = { v: 0 };
  const session = registerSession(conn, p, {
    write: (data) => stream.write(data),
    resize: (c, r) => {
      void exec!.resize({ h: r, w: c }).catch(() => undefined);
    },
    teardown: () => (stream as unknown as { destroy?: () => void }).destroy?.(),
  });

  stream.on('data', (chunk: Buffer) => {
    session.touch();
    sendData(conn, sessionId, seqRef, chunk);
  });
  const finish = async (): Promise<void> => {
    if (!sessions.has(sessionId)) return;
    sessions.delete(sessionId);
    let exitCode: number | null = null;
    try {
      const info = await exec!.inspect();
      exitCode = typeof info.ExitCode === 'number' ? info.ExitCode : null;
    } catch {
      // best-effort
    }
    conn.send('termExit', { sessionId, exitCode, reason: 'exit' });
  };
  stream.on('end', () => void finish());
  stream.on('close', () => void finish());
  stream.on('error', () => {
    if (!sessions.has(sessionId)) return;
    sessions.delete(sessionId);
    conn.send('termExit', { sessionId, exitCode: null, reason: 'error' });
  });

  // Apply the initial window size.
  session.resize(cols, rows);
}

function startNodeShell(
  conn: AgentConnection,
  p: TermStartPayload,
  target: Extract<TermTargetKind, { kind: 'nodeShell' }>,
): void {
  const { sessionId } = p;
  const shell = process.env.SHELL || '/bin/sh';
  const cmd = target.cmd.length > 0 ? target.cmd : [shell, '-l'];

  const child = nodeSpawn(cmd[0]!, cmd.slice(1), {
    env: { ...process.env, TERM: p.term },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as import('node:child_process').ChildProcessWithoutNullStreams & {
    on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
  };

  conn.send('termStarted', { sessionId, ok: true });

  const seqRef = { v: 0 };
  const session = registerSession(conn, p, {
    write: (data) => child.stdin?.write(data),
    resize: () => undefined, // no PTY → SIGWINCH not available in the degraded path
    teardown: () => child.kill('SIGTERM'),
  });

  const onData = (chunk: Buffer): void => {
    session.touch();
    sendData(conn, sessionId, seqRef, chunk);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', (code, signal) => {
    if (!sessions.has(sessionId)) return;
    sessions.delete(sessionId);
    conn.send('termExit', {
      sessionId,
      exitCode: code ?? null,
      signal: signal ?? undefined,
      reason: 'exit',
    });
  });
  child.on('error', () => {
    if (!sessions.has(sessionId)) return;
    sessions.delete(sessionId);
    conn.send('termExit', { sessionId, exitCode: null, reason: 'error' });
  });
}

interface SessionImpl {
  write: (data: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  teardown: () => void;
}

/** Wire up idle-timeout + bookkeeping shared by both targets. */
function registerSession(
  conn: AgentConnection,
  p: TermStartPayload,
  impl: SessionImpl,
): TermSession {
  const { sessionId, idleTimeoutMs } = p;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const session: TermSession = {
    sessionId,
    write: impl.write,
    resize: impl.resize,
    touch: () => {
      if (!idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => session.kill('idle_timeout'), idleTimeoutMs);
    },
    kill: (reason) => {
      if (!sessions.has(sessionId)) return;
      sessions.delete(sessionId);
      if (idleTimer) clearTimeout(idleTimer);
      impl.teardown();
      conn.send('termExit', { sessionId, exitCode: null, reason });
    },
  };
  sessions.set(sessionId, session);
  session.touch();
  return session;
}

export function handleTermInput(p: TermInputPayload): void {
  const s = sessions.get(p.sessionId);
  if (!s) return;
  s.touch();
  s.write(Buffer.from(p.data, 'base64'));
}

export function handleTermResize(p: TermResizePayload): void {
  const s = sessions.get(p.sessionId);
  if (!s) return;
  s.resize(p.cols, p.rows);
}

export function handleTermClose(p: TermClosePayload): void {
  sessions.get(p.sessionId)?.kill('killed');
}

// Local helper alias for the discriminated target union member types.
type TermTargetKind = TermStartPayload['target'];
