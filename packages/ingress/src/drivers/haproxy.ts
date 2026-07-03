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
    // Route protections are a Caddy-renderer feature; HAProxy renders routes fine
    // but silently skips them — surface that as a non-blocking warning.
    const protectedCount = config.domains.filter((d) => d.protection).length;
    const warningList: { path: string; message: string }[] = [];
    if (protectedCount) {
      warningList.push({
        path: 'domains',
        message: `${protectedCount} route(s) carry edge protections — the haproxy driver ignores them (use the Caddy driver to enforce).`,
      });
    }
    // Controller vhosts (status-page/webhook/AI custom domains) are also
    // Caddy-only today: those domains simply won't be served by this driver.
    if (config.controllerVhosts.length > 0) {
      warningList.push({
        path: 'controllerVhosts',
        message: `${config.controllerVhosts.length} custom domain(s) (status pages / webhooks / AI outlets) need the Caddy driver — the haproxy driver does not render them.`,
      });
    }
    const warnings = warningList.length ? warningList : undefined;
    return errors.length ? { ok: false, errors, warnings } : { ok: true, warnings };
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
