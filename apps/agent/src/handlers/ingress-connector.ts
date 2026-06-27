/**
 * Ingress connector handler (ingress-strategy epic).
 *
 * Deploys a tunnel connector (cloudflared / tailscale / ngrok) as a Swarm
 * service when `RenderedConfig.connector` is present. Mirrors `applyMesh` and
 * the executor's `deployOrUpdate`: it consumes a rendered payload and applies it
 * on the node without reasoning about which provider it is.
 *
 * Secrets (the tunnel run token) arrive over the authenticated WS inside
 * `connector.secrets[].value` (resolved just-in-time by the controller) and are
 * only ever injected as the connector service's env — never written to disk.
 *
 * cloudflared reads `TUNNEL_TOKEN` from the environment in token mode, so we
 * merge the resolved secrets into the ServiceSpec env rather than the command
 * line (which would leak the token via `ps`).
 */
import { DockerClient, toServiceCreateOptions } from '@swarmy/core/docker';
import type { RenderedConfig, ServiceSpec } from '@swarmy/core/protocol';

export interface ApplyConnectorResult {
  driver: string;
  connector: string;
  serviceId: string;
  created: boolean;
}

/** Idempotent create-or-update of the connector swarm service. */
async function deployOrUpdate(
  docker: DockerClient,
  spec: ServiceSpec,
): Promise<{ serviceId: string; created: boolean }> {
  const existing = await docker.getServiceByName(spec.name);
  if (!existing) {
    const id = await docker.createService(spec);
    return { serviceId: id, created: true };
  }
  const inspect = await existing.inspect();
  const opts = toServiceCreateOptions(spec) as Record<string, unknown>;
  await existing.update({ version: inspect.Version.Index, ...opts });
  return { serviceId: inspect.ID, created: false };
}

/**
 * Deploy / update the connector service carried by a RenderedConfig.connector
 * block. Returns null if there is no connector (caller falls back to the
 * file/label/reload path).
 */
export async function applyIngressConnector(
  docker: DockerClient,
  rendered: RenderedConfig,
): Promise<ApplyConnectorResult | null> {
  const connector = rendered.connector;
  if (!connector) return null;

  // Merge JIT-resolved secrets into the spec env (Docker secrets-grade handling
  // without a registry round-trip). Secret values are never persisted on disk.
  const env: Record<string, string> = { ...(connector.service.env ?? {}) };
  for (const s of connector.secrets) {
    if (s.value !== undefined) env[s.name] = s.value;
  }
  const spec: ServiceSpec = { ...connector.service, env };

  // Best-effort image pull so the first deploy doesn't race the scheduler.
  await docker.pullImage(spec.image).catch(() => undefined);

  const { serviceId, created } = await deployOrUpdate(docker, spec);
  return { driver: rendered.driver, connector: connector.kind, serviceId, created };
}
