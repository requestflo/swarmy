import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import type {
  DriverDispatch,
  IngressConfig,
  IngressDriver,
  IngressValidationResult,
} from '../types';
import { buildCaddyfile } from '../render/caddyfile';
import { IngressApplyError } from '../errors';

/** Swarm service name of the native Caddy ingress controller (deployed by
 *  `ensureCaddyController`). Routes pushed via the admin API target this name on
 *  the ingress overlay network. */
export const CADDY_CONTROLLER_SERVICE = 'swarmy-ingress-caddy';
/** Port the Caddy admin API listens on inside the controller. */
export const CADDY_ADMIN_PORT = 2019;
/** Caddyfile path on the node / controller bind mount. */
export const CADDY_CONFIG_PATH = '/etc/caddy/Caddyfile';

/**
 * Where the agent POSTs the rendered Caddyfile to apply it live. On a real swarm
 * the Caddy admin API lives INSIDE the controller service, not on the agent host,
 * so the default targets the controller by service name on the overlay. Override
 * with `extraConfig.adminUrl` — e.g. the published host port for single-node dev:
 * `http://127.0.0.1:2019/load`.
 */
export function caddyAdminLoadUrl(extra: Record<string, unknown>): string {
  if (typeof extra.adminUrl === 'string' && extra.adminUrl.length > 0) return extra.adminUrl;
  return `http://${CADDY_CONTROLLER_SERVICE}:${CADDY_ADMIN_PORT}/load`;
}

export class CaddyDriver implements IngressDriver {
  readonly name = 'caddy';

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
    if (config.globalOptions.onDemandTls && !config.globalOptions.email && !extra.onDemandAsk) {
      errors.push({
        path: 'globalOptions.onDemandTls',
        message: 'on-demand TLS requires an ACME email or an ask endpoint',
      });
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  render(config: IngressConfig): RenderedConfig {
    const contents = buildCaddyfile(config);
    const extra = config.globalOptions.extraConfig as Record<string, unknown>;
    const applyVia = typeof extra.applyVia === 'string' ? extra.applyVia : 'file';
    const rendered: RenderedConfig = {
      driver: 'caddy',
      files: [{ path: CADDY_CONFIG_PATH, contents, mode: 0o644 }],
      serviceLabels: [],
      summary: `Caddy — ${config.domains.length} route(s): ${
        config.domains.map((d) => d.domain).join(', ') || 'none'
      }`,
    };
    if (applyVia === 'admin') {
      // Push the full config to the controller's admin API. The agent also writes
      // `files` first (on the manager that becomes the controller's bind-mounted
      // base Caddyfile), so a `--resume`-less cold restart still has admin bound.
      rendered.adminApi = {
        method: 'POST',
        url: caddyAdminLoadUrl(extra),
        body: contents,
        contentType: 'text/caddyfile',
      };
    } else {
      rendered.reloadCommand = [
        'caddy',
        'reload',
        '--config',
        CADDY_CONFIG_PATH,
        '--adapter',
        'caddyfile',
      ];
    }
    return rendered;
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
      driver: 'caddy',
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
      return { driver: 'caddy', healthy: false, activeDomains: [], certs: [], message: 'no ingress nodes' };
    }
    return dispatch.queryStatus(first, 'caddy');
  }
}
