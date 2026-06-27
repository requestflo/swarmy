import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import type {
  DriverDispatch,
  IngressConfig,
  IngressDriver,
  IngressValidationResult,
} from '../types';
import { buildHaproxyConfig, HAPROXY_CONFIG_PATH } from '../render/haproxy';
import { IngressApplyError } from '../errors';

/**
 * HAProxy reverse-proxy driver. Pure render → a single haproxy.cfg + a reload
 * command. Routes by Host header (HTTP) / SNI (HTTPS) to a backend per domain.
 * No built-in ACME: `tls: auto` binds the cert directory an external companion
 * fills (see render/haproxy.ts).
 */
export class HaproxyDriver implements IngressDriver {
  readonly name = 'haproxy';

  validate(config: IngressConfig): IngressValidationResult {
    const errors: { path: string; message: string }[] = [];
    const extra = config.globalOptions.extraConfig as Record<string, unknown>;
    config.domains.forEach((r, i) => {
      if (r.tls === 'custom') {
        const certs = extra.certs as Record<string, unknown> | undefined;
        if (!certs?.[r.domain]) {
          errors.push({
            path: `domains[${i}].tls`,
            message: `custom TLS requires a combined PEM for ${r.domain}`,
          });
        }
      }
    });
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  render(config: IngressConfig): RenderedConfig {
    const contents = buildHaproxyConfig(config);
    return {
      driver: 'haproxy',
      files: [{ path: HAPROXY_CONFIG_PATH, contents, mode: 0o644 }],
      serviceLabels: [],
      // HAProxy reloads gracefully on SIGUSR2 with the master-worker model.
      reloadCommand: ['sh', '-c', 'kill -USR2 1 || haproxy -sf $(pidof haproxy)'],
      summary: `HAProxy — ${config.domains.length} route(s): ${
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
      driver: 'haproxy',
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
      return { driver: 'haproxy', healthy: false, activeDomains: [], certs: [], message: 'no ingress nodes' };
    }
    return dispatch.queryStatus(first, 'haproxy');
  }
}
