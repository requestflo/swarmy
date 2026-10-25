import type { DockerClient } from '@swarmy/core/docker';
import { createLogDemuxer } from '../log-demux';
import { EDGE_CADDY_SERVICE } from './edge-traffic';

/**
 * Exec inside THIS node's edge Caddy task and keep what it printed — the
 * shared half of the certificate read (`edgeCerts`) and renew
 * (`edgeCertRenew`). Same reach as `localReload` and the metrics scrape: the
 * task is found by its swarm service-name label on the local socket, the
 * admin API stays on the task's localhost, and no host file is touched.
 */

/** This node's running edge Caddy task (container id), or undefined when none runs here. */
export async function localEdgeTask(docker: DockerClient, service = EDGE_CADDY_SERVICE): Promise<string | undefined> {
  const list = await docker.docker.listContainers({
    filters: { label: [`com.docker.swarm.service.name=${service}`], status: ['running'] },
  });
  return list[0]?.Id;
}

export interface ExecOutput {
  exitCode: number;
  stdout: string;
  /** The last 400 characters of stderr, for an error message. */
  stderr: string;
  /** stdout went past `maxBytes` and was cut. */
  capped: boolean;
}

/** One non-interactive exec; stdout kept up to `maxBytes` (8 MiB default). Never throws on a non-zero exit. */
export async function execCapture(
  docker: DockerClient,
  containerId: string,
  opts: { Cmd: string[]; Env?: string[] },
  maxBytes = 8 * 1024 * 1024,
): Promise<ExecOutput> {
  const exec = await docker.docker.getContainer(containerId).exec({ ...opts, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  let stdout = '';
  let stderr = '';
  let capped = false;
  const demux = createLogDemuxer((name, text) => {
    if (name === 'stderr') {
      stderr = (stderr + text).slice(-400);
      return;
    }
    if (stdout.length + text.length > maxBytes) {
      stdout += text.slice(0, Math.max(0, maxBytes - stdout.length));
      capped = true;
    } else stdout += text;
  });
  await new Promise<void>((resolve) => {
    stream.on('data', (chunk: Buffer) => demux(chunk));
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });
  const inspect = await exec.inspect();
  return { exitCode: inspect.ExitCode ?? -1, stdout, stderr: stderr.trim(), capped };
}
