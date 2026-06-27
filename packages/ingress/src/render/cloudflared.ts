import type { IngressConfig } from '../types';

/**
 * Cloudflare Tunnel (cloudflared) render output. Pure string construction.
 *
 * We use a *locally-managed* config shape (config.yml + credentials file) so the
 * connector can run on any node the agent controls without an inbound port. The
 * tunnel run-token / credentials are resolved just-in-time by the controller and
 * written into the credentials file the agent persists on the node.
 *
 * Plan note: the design also describes a remotely-managed (token) mode where the
 * connector runs as a Swarm service via `cloudflared tunnel run --token <TOKEN>`.
 * That mode is carried by the optional `connector` block on RenderedConfig (added
 * by the integrator — see INTEGRATION). This renderer covers the file-on-node
 * path that fits the *current* RenderedConfig shape (files + reloadCommand).
 */

export interface CloudflaredRenderInput {
  /** Tunnel UUID (Cloudflare-assigned). */
  tunnelId: string;
  /** Tunnel name (for display / `cloudflared tunnel run <name>`). */
  tunnelName: string;
  /**
   * The credentials JSON for the tunnel (account tag, tunnel secret, tunnel id).
   * Resolved from the credential vault at dispatch — never persisted in plaintext
   * in the controller DB.
   */
  credentialsJson?: string;
  /** cloudflared metrics/diagnostics bind, e.g. `127.0.0.1:2000`. */
  metricsAddr?: string;
}

const CONFIG_PATH = '/etc/cloudflared/config.yml';
const CREDENTIALS_PATH = '/etc/cloudflared/credentials.json';

/** Build the cloudflared `config.yml` ingress rules from the org config. */
export function buildCloudflaredConfig(config: IngressConfig, input: CloudflaredRenderInput): string {
  const out: string[] = [];
  out.push(`tunnel: ${input.tunnelId}`);
  out.push(`credentials-file: ${CREDENTIALS_PATH}`);
  if (input.metricsAddr) out.push(`metrics: ${input.metricsAddr}`);
  out.push('ingress:');
  for (const r of config.domains) {
    const scheme = r.tls === 'off' ? 'http' : 'http';
    const service = `${scheme}://${r.service}:${r.port}`;
    out.push(`  - hostname: ${r.domain}`);
    out.push(`    service: ${service}`);
    if (r.pathPrefix && r.pathPrefix !== '/') {
      out.push(`    path: ${r.pathPrefix}`);
    }
  }
  // Mandatory catch-all rule (cloudflared requires the last rule to have no host).
  out.push('  - service: http_status:404');
  return `${out.join('\n')}\n`;
}

/** Cloudflare ingress-rule array (the JSON pushed to the CF API in token mode). */
export function buildCloudflaredIngressRules(
  config: IngressConfig,
): { hostname?: string; service: string; path?: string }[] {
  const rules = config.domains.map((r) => {
    const rule: { hostname?: string; service: string; path?: string } = {
      hostname: r.domain,
      service: `http://${r.service}:${r.port}`,
    };
    if (r.pathPrefix && r.pathPrefix !== '/') rule.path = r.pathPrefix;
    return rule;
  });
  rules.push({ service: 'http_status:404' });
  return rules;
}

export const CLOUDFLARED_CONFIG_PATH = CONFIG_PATH;
export const CLOUDFLARED_CREDENTIALS_PATH = CREDENTIALS_PATH;
