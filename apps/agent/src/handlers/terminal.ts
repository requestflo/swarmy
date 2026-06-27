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
 * Targets:
 *   - container : dockerode exec, gated by `SWARMY_ALLOW_EXEC` (env.ALLOW_EXEC).
 *   - nodeShell : a host shell, gated by the SEPARATE `SWARMY_ALLOW_NODE_SHELL`
 *                 (env.ALLOW_NODE_SHELL). Uses a real host PTY via `node-pty`
 *                 when the native module is present (job control, `clear`, vim);
 *                 otherwise falls back to a degraded `child_process` pipe (no
 *                 SIGWINCH / job control) so the agent never fails to build.
 *
 * Limits: per-session idle-timeout (TermStart.idleTimeoutMs) and a hard
 * per-session output cap (env.TERM_MAX_OUTPUT_BYTES; `yes`-bomb guard) that
 * kills the session with `ptyExit{reason:'killed'}`.
 *
 * Routed from executor.ts: `termStart` → start, `termInput`/`termResize`/
 * `termClose` → the matching live session.
 */

interface TermSession {
  sessionId: string;
  write: (data: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  kill: (reason: 'killed' | 'idle_timeout' | 'agent_shutdown') => void;
  touch: () => void;
  /** Account for output bytes; returns false once the hard cap is exceeded. */
  account: (n: number) => boolean;
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

/**
 * Pure agent-side gating decision for a terminal target. Container exec rides
 * `SWARMY_ALLOW_EXEC`; node shell rides the SEPARATE `SWARMY_ALLOW_NODE_SHELL`.
 * Exported for unit testing the gate independently of dockerode/spawn.
 */
export function gateTarget(
  target: TermStartPayload['target'],
  flags: { allowExec: boolean; allowNodeShell: boolean },
): { ok: true } | { ok: false; code: 'E_EXEC_DISABLED' | 'E_NODE_SHELL_DISABLED'; message: string } {
  if (target.kind === 'container') {
    return flags.allowExec
      ? { ok: true }
      : { ok: false, code: 'E_EXEC_DISABLED', message: 'exec disabled on this agent' };
  }
  return flags.allowNodeShell
    ? { ok: true }
    : { ok: false, code: 'E_NODE_SHELL_DISABLED', message: 'node shell disabled on this agent' };
}

export async function handleTermStart(
  docker: DockerClient,
  conn: AgentConnection,
  p: TermStartPayload,
): Promise<void> {
  const { sessionId, target } = p;
  if (sessions.has(sessionId)) return; // already running; ignore duplicate

  const gate = gateTarget(target, {
    allowExec: env.ALLOW_EXEC,
    allowNodeShell: env.ALLOW_NODE_SHELL,
  });
  if (!gate.ok) {
    conn.send('termStarted', {
      sessionId,
      ok: false,
      error: { code: gate.code, message: gate.message },
    });
    return;
  }

  try {
    if (target.kind === 'container') {
      await startContainerExec(docker, conn, p, target);
      return;
    }
    await startNodeShell(conn, p, target);
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
    if (!session.account(chunk.length)) {
      session.kill('killed');
      return;
    }
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

/** Minimal structural type of the bits of `node-pty` we use. */
interface PtyProcessLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ): PtyProcessLike;
}

/** Best-effort load of the optional native `node-pty`. Returns null if absent. */
async function loadNodePty(): Promise<NodePtyModule | null> {
  try {
    // Dynamic + indirected so bundlers don't hard-require the native module and
    // the agent still builds/runs where node-pty isn't installed.
    const mod = (await import(/* @vite-ignore */ 'node-pty' as string)) as unknown as NodePtyModule;
    return typeof mod?.spawn === 'function' ? mod : null;
  } catch {
    return null;
  }
}

async function startNodeShell(
  conn: AgentConnection,
  p: TermStartPayload,
  target: Extract<TermTargetKind, { kind: 'nodeShell' }>,
): Promise<void> {
  const { sessionId, cols, rows, term } = p;
  const shell = target.cmd[0] ?? process.env.SHELL ?? '/bin/sh';
  const args = target.cmd.length > 0 ? target.cmd.slice(1) : ['-l'];

  const pty = await loadNodePty();
  const seqRef = { v: 0 };

  if (pty) {
    // Real host PTY: full job control, SIGWINCH, vim/clear work.
    const proc = pty.spawn(shell, args, {
      name: term || 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME,
      env: { ...process.env, TERM: term },
    });
    conn.send('termStarted', { sessionId, ok: true });
    const session = registerSession(conn, p, {
      write: (data) => proc.write(data.toString('binary')),
      resize: (c, r) => proc.resize(c, r),
      teardown: () => proc.kill(),
    });
    proc.onData((data) => {
      session.touch();
      const buf = Buffer.from(data, 'binary');
      if (!session.account(buf.length)) {
        session.kill('killed');
        return;
      }
      sendData(conn, sessionId, seqRef, buf);
    });
    proc.onExit(({ exitCode, signal }) => {
      if (!sessions.has(sessionId)) return;
      sessions.delete(sessionId);
      conn.send('termExit', {
        sessionId,
        exitCode,
        signal: signal != null ? String(signal) : undefined,
        reason: 'exit',
      });
    });
    return;
  }

  // Degraded fallback: a plain child process (no PTY → no SIGWINCH / job control).
  const child = nodeSpawn(shell, args, {
    env: { ...process.env, TERM: term },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as import('node:child_process').ChildProcessWithoutNullStreams & {
    on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
  };
  conn.send('termStarted', { sessionId, ok: true });
  const session = registerSession(conn, p, {
    write: (data) => void child.stdin?.write(data),
    resize: () => undefined, // no PTY → SIGWINCH unavailable in the degraded path
    teardown: () => child.kill('SIGTERM'),
  });
  const onData = (chunk: Buffer): void => {
    session.touch();
    if (!session.account(chunk.length)) {
      session.kill('killed');
      return;
    }
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

/** Wire up idle-timeout + output cap + bookkeeping shared by all targets. */
function registerSession(
  conn: AgentConnection,
  p: TermStartPayload,
  impl: SessionImpl,
): TermSession {
  const { sessionId, idleTimeoutMs } = p;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let bytesOut = 0;
  const cap = env.TERM_MAX_OUTPUT_BYTES;

  const session: TermSession = {
    sessionId,
    write: impl.write,
    resize: impl.resize,
    account: (n) => {
      bytesOut += n;
      return cap <= 0 || bytesOut <= cap;
    },
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

/** Tear down every live session (agent shutdown). */
export function shutdownAllTermSessions(): void {
  for (const s of [...sessions.values()]) s.kill('agent_shutdown');
}

// Local helper alias for the discriminated target union member types.
type TermTargetKind = TermStartPayload['target'];
