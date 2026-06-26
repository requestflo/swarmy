import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import type {
  DriverDispatch,
  IngressConfig,
  IngressDriver,
  IngressValidationResult,
} from '../types';
import { buildCaddyfile } from '../render/caddyfile';
import { IngressApplyError } from '../errors';

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
    const applyVia = (config.globalOptions.extraConfig as Record<string, unknown>).applyVia ?? 'file';
    const rendered: RenderedConfig = {
      driver: 'caddy',
      files: [{ path: '/etc/caddy/Caddyfile', contents, mode: 0o644 }],
      serviceLabels: [],
      summary: `Caddy — ${config.domains.length} route(s): ${
        config.domains.map((d) => d.domain).join(', ') || 'none'
      }`,
    };
    if (applyVia === 'admin') {
      rendered.adminApi = {
        method: 'POST',
        url: 'http://127.0.0.1:2019/load',
        body: contents,
        contentType: 'text/caddyfile',
      };
    } else {
      rendered.reloadCommand = [
        'caddy',
        'reload',
        '--config',
        '/etc/caddy/Caddyfile',
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
