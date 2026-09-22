import type { DockerClient } from '@swarmy/core/docker';

/**
 * Edge-per-node config reload (geo-edge). The agent wrote the rendered
 * Caddyfile to a host path bind-mounted (ro) into the local Caddy task; now
 * exec `caddy reload` inside that task. `docker ps` on a node only returns
 * LOCAL containers, so filtering by the swarm service-name label finds exactly
 * this node's task — no cluster-VIP admin API, port 2019 never published.
 *
 * No running local task is an ERROR (surfaced per-node in the driver report),
 * not a silent skip: an ingress-labeled node without its Caddy task is a real
 * degradation the operator must see.
 */
/**
 * Shell snippet that materialises a file inside the task from env (base64, so
 * any bytes survive). Env rather than argv/stdin: exec stdin attach is
 * unreliable under Bun, and a Caddyfile comfortably fits the ~128KiB
 * single-env-string limit. Pure — exported for the golden test.
 */
export function writeFileExec(file: { path: string; contents: string }): {
  Cmd: string[];
  Env: string[];
} {
  return {
    Cmd: [
      'sh',
      '-c',
      'mkdir -p "$(dirname "$SWARMY_FILE_PATH")" && ' +
        'printf %s "$SWARMY_FILE_B64" | base64 -d > "$SWARMY_FILE_PATH"',
    ],
    Env: [
      `SWARMY_FILE_PATH=${file.path}`,
      `SWARMY_FILE_B64=${Buffer.from(file.contents, 'utf8').toString('base64')}`,
    ],
  };
}

/** Run one non-interactive exec in a container; throws on a non-zero exit. */
async function runExec(
  docker: DockerClient,
  containerId: string,
  opts: { Cmd: string[]; Env?: string[] },
  what: string,
): Promise<void> {
  const container = docker.docker.getContainer(containerId);
  const exec = await container.exec({ ...opts, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  // Drain output; non-interactive streams resolve fine under Bun (only
  // hijacked TTY exec needs the raw-socket path — see exec-attach.ts).
  let output = '';
  await new Promise<void>((resolve) => {
    stream.on('data', (chunk: Buffer) => {
      if (output.length < 2048) output += chunk.toString('utf8');
    });
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });
  const inspect = await exec.inspect();
  if (inspect.ExitCode !== 0) {
    // Strip docker's 8-byte stream-multiplex headers' control chars for a readable tail.
    const tail = output.replace(/[\x00-\x08]/g, '').trim().slice(-400);
    throw new Error(`${what} exited ${inspect.ExitCode}${tail ? `: ${tail}` : ''}`);
  }
}

export async function localReload(
  docker: DockerClient,
  service: string,
  command: string[],
  file?: { path: string; contents: string },
): Promise<void> {
  const containers = await docker.docker.listContainers({
    filters: { label: [`com.docker.swarm.service.name=${service}`], status: ['running'] },
  });
  const target = containers[0];
  if (!target) {
    throw new Error(`no running local task of service ${service} — cannot reload edge config`);
  }

  if (file) await runExec(docker, target.Id, writeFileExec(file), `write ${file.path}`);
  await runExec(docker, target.Id, { Cmd: command }, command[0] ?? 'command');
}
