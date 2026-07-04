import type { IngressNodeStatusPayload } from '@swarmy/core/protocol';
import type { DockerClient } from '@swarmy/core/docker';

/**
 * Edge health sampling (geo-edge): does THIS node currently run a task of the
 * edge Caddy and of swarmy-dns? Local `docker ps` truth, pushed to the
 * controller like meshState — DNS answers must drop a node whose Caddy died
 * even while the agent websocket is perfectly healthy.
 */
const EDGE_SERVICES = ['swarmy-ingress-caddy', 'swarmy-dns'] as const;

export async function sampleIngressStatus(
  docker: DockerClient,
): Promise<IngressNodeStatusPayload> {
  const running = new Set<string>();
  for (const service of EDGE_SERVICES) {
    try {
      const list = await docker.docker.listContainers({
        filters: { label: [`com.docker.swarm.service.name=${service}`], status: ['running'] },
      });
      if (list.length > 0) running.add(service);
    } catch {
      // docker hiccup — report not-running; next sample self-heals
    }
  }
  return {
    caddyRunning: running.has('swarmy-ingress-caddy'),
    dnsRunning: running.has('swarmy-dns'),
    sampledAt: Date.now(),
  };
}
