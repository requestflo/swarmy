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
export async function localReload(
  docker: DockerClient,
  service: string,
  command: string[],
): Promise<void> {
  const containers = await docker.docker.listContainers({
    filters: { label: [`com.docker.swarm.service.name=${service}`], status: ['running'] },
  });
  const target = containers[0];
  if (!target) {
    throw new Error(`no running local task of service ${service} — cannot reload edge config`);
  }

  const container = docker.docker.getContainer(target.Id);
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  // Drain output; non-interactive streams resolve fine under Bun (only
  // hijacked TTY exec needs the raw-socket path — see exec-attach.ts).
  await new Promise<void>((resolve) => {
    stream.on('data', () => undefined);
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });

  const inspect = await exec.inspect();
  if (inspect.ExitCode !== 0) {
    throw new Error(`${command[0]} exited ${inspect.ExitCode} in local ${service} task`);
  }
}
