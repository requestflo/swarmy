/**
 * Non-interactive container exec — the `execCommand` wire command.
 *
 * Controller services (vector/search stats, pgvector enable, the restore and
 * failover drills, several reconcile workers) dispatch `exec` with
 * `stream: false` and read `{ exitCode, output }`. Interactive shells are the
 * terminal's job (`terminal.ts`, raw-socket hijack); this path never attaches
 * stdin, so dockerode's non-hijacked `exec.start` works under Bun.
 *
 * Gate: the executor checks `execGateAllows` (SWARMY_ALLOW_EXEC veto +
 * the controller's `nodeCapable`) before calling in here. Output is capped so
 * a chatty command can't balloon agent memory or the WS frame, and the
 * command's deadline (payload `timeoutMs`, else the per-command default) is
 * enforced here so a wedged exec still answers its `commandId`.
 */
import type { DockerClient } from '@swarmy/core/docker';
import { DEFAULT_COMMAND_TIMEOUTS, type ExecCommandMsg } from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';

/** Max bytes of stdout (and, separately, stderr) kept per exec. */
export const EXEC_OUTPUT_CAP = 1024 * 1024;

/**
 * Split Docker's multiplexed (non-TTY) stream: 8-byte frames `[type,0,0,0,
 * size(u32 BE)]` + payload, type 1 = stdout, 2 = stderr. A buffer that is not
 * framed (a TTY stream) is returned whole as stdout.
 */
export function demuxDockerStream(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i]!;
    if ((type !== 0 && type !== 1 && type !== 2) || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) {
      return { stdout: buf.toString('utf8'), stderr: '' };
    }
    const size = buf.readUInt32BE(i + 4);
    const chunk = buf.subarray(i + 8, i + 8 + size);
    (type === 2 ? err : out).push(chunk);
    i += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

function cap(s: string): string {
  return s.length > EXEC_OUTPUT_CAP ? s.slice(0, EXEC_OUTPUT_CAP) : s;
}

export interface ExecCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one command in a container and capture its output. Rejects on timeout
 * (the process may keep running in the container; Docker has no exec kill).
 */
export async function execCapture(
  docker: DockerClient,
  containerId: string,
  opts: {
    cmd: string[];
    env?: string[];
    tty?: boolean;
    timeoutMs?: number;
    /** Raw chunks as they arrive (for `stream: true`). */
    onChunk?: (data: string) => void;
  },
): Promise<ExecCaptureResult> {
  const tty = opts.tty ?? false;
  const exec = await docker.docker.getContainer(containerId).exec({
    Cmd: opts.cmd,
    ...(opts.env?.length ? { Env: opts.env } : {}),
    AttachStdout: true,
    AttachStderr: true,
    Tty: tty,
  });
  const stream = (await exec.start({ Tty: tty })) as unknown as NodeJS.ReadableStream & {
    destroy?: () => void;
  };
  const chunks: Buffer[] = [];
  let bytes = 0;
  const done = new Promise<void>((resolve) => {
    stream.on('data', (c: Buffer) => {
      const b = Buffer.from(c);
      if (bytes < EXEC_OUTPUT_CAP * 2 + 64) {
        chunks.push(b);
        bytes += b.length;
      }
      opts.onChunk?.(tty ? b.toString('utf8') : demuxDockerStream(b).stdout);
    });
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
    stream.on('error', () => resolve());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout =
    opts.timeoutMs && opts.timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            stream.destroy?.();
            reject(new Error(`exec timed out after ${Math.round(opts.timeoutMs! / 1000)}s`));
          }, opts.timeoutMs);
        })
      : null;
  try {
    await (timeout ? Promise.race([done, timeout]) : done);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const inspect = await exec.inspect();
  const raw = Buffer.concat(chunks);
  const { stdout, stderr } = tty ? { stdout: raw.toString('utf8'), stderr: '' } : demuxDockerStream(raw);
  return { exitCode: inspect.ExitCode ?? 0, stdout: cap(stdout), stderr: cap(stderr) };
}

/**
 * `{ exitCode, output }` the controller's exec callers read. `output` is
 * stdout; on a non-zero exit stderr is appended so the error is visible.
 */
export function execResultView(r: ExecCaptureResult): { exitCode: number; output: string; stderr: string } {
  const output = r.exitCode === 0 || !r.stderr ? r.stdout : `${r.stdout}${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}`;
  return { exitCode: r.exitCode, output, stderr: r.stderr };
}

export async function execCommand(
  docker: DockerClient,
  conn: AgentConnection,
  p: ExecCommandMsg['payload'],
): Promise<{ exitCode: number; output: string; stderr: string }> {
  let seq = 0;
  const r = await execCapture(docker, p.target.containerId, {
    cmd: p.cmd,
    tty: p.tty,
    timeoutMs: p.timeoutMs ?? DEFAULT_COMMAND_TIMEOUTS.execCommand,
    ...(p.stream
      ? {
          onChunk: (data: string) =>
            conn.send('logChunk', { commandId: p.commandId, stream: 'stdout', seq: seq++, data, eof: false }),
        }
      : {}),
  });
  if (p.stream) conn.send('logChunk', { commandId: p.commandId, stream: 'stdout', seq: seq++, data: '', eof: true });
  return execResultView(r);
}
