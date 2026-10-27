import type { DockerClient } from '@swarmy/core/docker';
import { createFrameDemuxer } from '../frame-demux';

/**
 * A one-shot sidecar whose stdout is STREAMED, not collected (`runSidecar`
 * keeps it all in a string; a volume dump would not fit). The caller reads
 * stdout as it comes and may `pause()` it: the attach socket stops being
 * read, so the container blocks on its own stdout — backpressure with no
 * agent-side buffer. Logging is off for the container, so the bytes never
 * land in a json-file log on the node. Credentials stay container env only.
 *
 * Two steps so the caller holds the handle before any byte arrives:
 * `prepareSidecarStream` creates + attaches, `start()` runs it.
 */

export interface SidecarStream {
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  /** The exit code, once the container exited AND its output was read. Valid after `start()`. */
  done: Promise<number>;
  /** The last 8 KiB of stderr. */
  stderr(): string;
  /** Kill the container and stop reading; `done` then settles. */
  kill(): void;
}

interface Attach extends NodeJS.ReadableStream {
  destroy?: () => void;
}

const STDERR_KEEP = 8192;

export async function prepareSidecarStream(
  docker: DockerClient,
  opts: { image: string; args: string[]; env: string[]; binds: string[]; networkMode?: string },
  onStdout: (data: Buffer) => void,
): Promise<SidecarStream> {
  const d = docker.docker;
  await docker.pullImage(opts.image).catch(() => undefined);
  const container = await d.createContainer({
    Image: opts.image,
    Cmd: opts.args,
    Env: opts.env,
    Tty: false,
    HostConfig: { Binds: opts.binds, AutoRemove: false, NetworkMode: opts.networkMode, LogConfig: { Type: 'none', Config: {} } },
  });
  const remove = () => container.remove({ force: true, v: true }).catch(() => undefined);
  let attach: Attach;
  try {
    attach = (await container.attach({ stream: true, stdout: true, stderr: true })) as unknown as Attach;
  } catch (e) {
    await remove();
    throw e;
  }
  let stderr = '';
  let isStarted = false;
  const kill = () => {
    attach.destroy?.();
    // Never started: nothing will reach `done`'s cleanup, so remove it here.
    if (!isStarted) void remove();
    else void container.kill().catch(() => undefined);
  };
  const feed = createFrameDemuxer((stream, data) => {
    if (stream === 'stdout') onStdout(data);
    else stderr = (stderr + data.toString('utf8')).slice(-STDERR_KEEP);
  });
  const drained = new Promise<void>((resolve) => {
    attach.on('end', resolve);
    attach.on('close', resolve);
    attach.on('error', resolve);
  });
  attach.on('data', (chunk: Buffer) => {
    try {
      feed(chunk);
    } catch (e) {
      stderr += `\n${e instanceof Error ? e.message : String(e)}`;
      kill();
    }
  });
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const done = (async () => {
    await running;
    try {
      const status = (await container.wait()) as { StatusCode?: number };
      await drained;
      return status.StatusCode ?? 0;
    } finally {
      await remove();
    }
  })();
  return {
    async start() {
      try {
        isStarted = true;
        await container.start();
      } catch (e) {
        attach.destroy?.();
        await remove();
        throw e;
      }
      started();
    },
    pause: () => attach.pause(),
    resume: () => attach.resume(),
    done,
    stderr: () => stderr,
    kill,
  };
}
