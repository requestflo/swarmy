import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import type {
  DriverDispatch,
  IngressConfig,
  IngressDriver,
  IngressValidationResult,
} from '../types';
import {
  buildCloudflaredConfig,
  buildCloudflaredIngressRules,
  CLOUDFLARED_CONFIG_PATH,
  CLOUDFLARED_CREDENTIALS_PATH,
} from '../render/cloudflared';
import { IngressApplyError } from '../errors';

/**
 * Cloudflare Tunnel driver. Unlike Caddy/Traefik it does not need a public
 * inbound port — the connector dials out to Cloudflare. It renders a cloudflared
 * `config.yml` (ingress rules) + a credentials file, applied on the target
 * node(s); a `reloadCommand` restarts the connector to pick up the new config.
 *
 * The Cloudflare *API* calls (create tunnel, push configurations, DNS routes)
 * are controller-side (see tunnel.service / cloudflare.client in INTEGRATION) —
 * this driver stays pure and only produces the on-node connector config.
 */
export class CloudflaredDriver implements IngressDriver {
  readonly name = 'cloudflared';

  validate(config: IngressConfig): IngressValidationResult {
    const errors: { path: string; message: string }[] = [];
    const tunnel = config.globalOptions.tunnel;
    if (!tunnel) {
      errors.push({
        path: 'globalOptions.tunnel',
        message: 'cloudflared requires tunnel options (provider/tunnelId)',
      });
      return { ok: false, errors };
    }
    if (!tunnel.tunnelId) {
      errors.push({
        path: 'globalOptions.tunnel.tunnelId',
        message: 'a Cloudflare tunnel must be created before applying (missing tunnelId)',
      });
    }
    if (!tunnel.runToken && !tunnel.credentialsJson) {
      errors.push({
        path: 'globalOptions.tunnel',
        message: 'cloudflared requires a run token or tunnel credentials (resolved from the vault)',
      });
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  render(config: IngressConfig): RenderedConfig {
    const tunnel = config.globalOptions.tunnel;
    const tunnelId = tunnel?.tunnelId ?? '';
    const tunnelName = tunnel?.tunnelName ?? 'swarmy';
    const contents = buildCloudflaredConfig(config, {
      tunnelId,
      tunnelName,
      credentialsJson: tunnel?.credentialsJson,
      metricsAddr: tunnel?.metricsAddr,
    });

    const files: RenderedConfig['files'] = [
      { path: CLOUDFLARED_CONFIG_PATH, contents, mode: 0o644 },
    ];
    // Credentials file (locally-managed mode). Secret is resolved JIT by the
    // controller and injected into globalOptions.tunnel.credentialsJson.
    if (tunnel?.credentialsJson) {
      files.push({
        path: CLOUDFLARED_CREDENTIALS_PATH,
        contents: tunnel.credentialsJson,
        mode: 0o600,
      });
    }

    return {
      driver: 'cloudflared',
      files,
      serviceLabels: [],
      // Run the connector against the rendered config. In token mode the
      // connector is deployed as a Swarm service instead (carried by the
      // RenderedConfig.connector block — see INTEGRATION).
      reloadCommand: [
        'cloudflared',
        'tunnel',
        '--config',
        CLOUDFLARED_CONFIG_PATH,
        'run',
        tunnelName,
      ],
      summary: `Cloudflare Tunnel "${tunnelName}" — ${config.domains.length} route(s): ${
        config.domains.map((d) => d.domain).join(', ') || 'none'
      }. No public ports required.`,
    };
  }

  async apply(
    rendered: RenderedConfig,
    dispatch: DriverDispatch,
    config: IngressConfig,
  ): Promise<IngressStatus> {
    const nodes = await dispatch.resolveTargetNodes(config.orgId, config.targetNodes);
    if (!nodes.length) {
      throw new IngressApplyError('(none)', 'no online nodes to run the cloudflared connector');
    }
    const reports = await Promise.all(nodes.map((n) => dispatch.sendToNode(n, rendered)));
    const failed = reports.find((r) => !r.ok);
    if (failed) throw new IngressApplyError(failed.nodeId, failed.message ?? 'apply failed');
    return {
      driver: 'cloudflared',
      healthy: true,
      activeDomains: config.domains.map((d) => d.domain),
      certs: [],
      lastAppliedAt: new Date().toISOString(),
      message: `connector running on ${nodes.length} node(s)`,
    };
  }

  async status(config: IngressConfig, dispatch: DriverDispatch): Promise<IngressStatus> {
    const nodes = await dispatch.resolveTargetNodes(config.orgId, config.targetNodes);
    const first = nodes[0];
    if (!first) {
      return {
        driver: 'cloudflared',
        healthy: false,
        activeDomains: [],
        certs: [],
        message: 'no connector nodes',
      };
    }
    return dispatch.queryStatus(first, 'cloudflared');
  }

  /** Expose the CF ingress-rule JSON for previews / the controller's API push. */
  ingressRules(config: IngressConfig) {
    return buildCloudflaredIngressRules(config);
  }
}
