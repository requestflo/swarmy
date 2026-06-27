import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import type {
  DriverDispatch,
  IngressConfig,
  IngressDriver,
  IngressValidationResult,
} from '../types';
import { buildNginxConfig, NGINX_CONFIG_PATH } from '../render/nginx';
import { IngressApplyError } from '../errors';

/**
 * nginx reverse-proxy driver. Pure render → a single conf.d file + a reload
 * command (`nginx -s reload`). Like Caddy/Traefik it fans the same config to
 * every target node. nginx has no built-in ACME, so `tls: auto` assumes an
 * external companion manages certs (see render/nginx.ts).
 */
export class NginxDriver implements IngressDriver {
  readonly name = 'nginx';

  validate(config: IngressConfig): IngressValidationResult {
    const errors: { path: string; message: string }[] = [];
    const extra = config.globalOptions.extraConfig as Record<string, unknown>;
    config.domains.forEach((r, i) => {
      if (r.tls === 'custom') {
        const certs = extra.certs as Record<string, unknown> | undefined;
        if (!certs?.[r.domain]) {
          errors.push({
            path: `domains[${i}].tls`,
            message: `custom TLS requires cert material for ${r.domain}`,
          });
        }
      }
    });
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  render(config: IngressConfig): RenderedConfig {
    const contents = buildNginxConfig(config);
    return {
      driver: 'nginx',
      files: [{ path: NGINX_CONFIG_PATH, contents, mode: 0o644 }],
      serviceLabels: [],
      reloadCommand: ['nginx', '-s', 'reload'],
      summary: `nginx — ${config.domains.length} route(s): ${
        config.domains.map((d) => d.domain).join(', ') || 'none'
      }`,
    };
  }

  async apply(
    rendered: RenderedConfig,
    dispatch: DriverDispatch,
    config: IngressConfig,
  ): Promise<IngressStatus> {
    const nodes = await dispatch.resolveTargetNodes(config.orgId, config.targetNodes);
    const reports = await Promise.all(nodes.map((n) => dispatch.sendToNode(n, rendered)));
    const failed = reports.find((r) => !r.ok);
    if (failed) throw new IngressApplyError(failed.nodeId, failed.message ?? 'apply failed');
    return {
      driver: 'nginx',
      healthy: true,
      activeDomains: config.domains.map((d) => d.domain),
      certs: [],
      lastAppliedAt: new Date().toISOString(),
      message: `applied to ${nodes.length} node(s)`,
    };
  }

  async status(config: IngressConfig, dispatch: DriverDispatch): Promise<IngressStatus> {
    const nodes = await dispatch.resolveTargetNodes(config.orgId, config.targetNodes);
    const first = nodes[0];
    if (!first) {
      return { driver: 'nginx', healthy: false, activeDomains: [], certs: [], message: 'no ingress nodes' };
    }
    return dispatch.queryStatus(first, 'nginx');
  }
}
