import type { ServiceSpec } from '@swarmy/core/protocol';
import type { IngressConfig } from '../types';

/**
 * Build the Swarm ServiceSpec for a cloudflared connector running in
 * remotely-managed (token) mode: `cloudflared tunnel run --token <TOKEN>`.
 *
 * The run token is NOT inlined here — it is carried as a connector secret
 * (see RenderedConfig.connector.secrets) and injected as the `TUNNEL_TOKEN`
 * env by the agent just-in-time. cloudflared reads `TUNNEL_TOKEN` from the
 * environment when no token is passed on the CLI, so we pass it via env (a
 * Docker secret) rather than the command line (which would leak via `ps`).
 *
 * No inbound ports: the connector dials out to Cloudflare. Ingress rules
 * (hostname → service) are configured server-side via the CF API, so the
 * connector never needs a config file in token mode.
 */

/** Env var cloudflared reads the run token from. */
export const CLOUDFLARED_SECRET_NAME = 'TUNNEL_TOKEN';

const DEFAULT_CONNECTOR_NAME = 'swarmy-cloudflared';

export function buildConnectorServiceSpec(config: IngressConfig): ServiceSpec {
  const t = config.globalOptions.tunnel;
  const image = t?.image ?? 'cloudflare/cloudflared:latest';
  const replicas = t?.replicas ?? 1;
  const network = config.globalOptions.network ?? 'swarmy';
  return {
    name: DEFAULT_CONNECTOR_NAME,
    image,
    mode: { replicated: { replicas } },
    // Token mode: no config file, no credentials file. `--no-autoupdate` keeps
    // the pinned image authoritative; metrics bind aids diagnostics.
    command: ['tunnel', '--no-autoupdate', '--metrics', '0.0.0.0:2000', 'run'],
    networks: [network],
    restartPolicy: { condition: 'any' },
    labels: { 'swarmy.managed': 'ingress', 'swarmy.ingress.connector': 'cloudflared' },
  };
}
