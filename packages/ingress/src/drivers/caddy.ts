import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import type {
  DriverDispatch,
  IngressConfig,
  IngressDriver,
  IngressValidationResult,
  IngressValidationWarning,
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
/** Edge-per-node service name (global mode, host-mode 80/443 — geo-edge). */
export const CADDY_EDGE_SERVICE = 'swarmy-ingress-caddy';
/** Host path the agent writes; bind-mounted ro into the edge task at /etc/caddy. */
export const CADDY_EDGE_HOST_DIR = '/var/lib/swarmy/ingress';
export const CADDY_EDGE_HOST_CONFIG = `${CADDY_EDGE_HOST_DIR}/Caddyfile`;

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
    // Non-blocking: `rate_limit` is a plugin (mholt/caddy-ratelimit) that the
    // stock caddy:2-alpine image does NOT carry — routes render fine but Caddy
    // rejects the config at load time. The swarmy build (docker/caddy-swarmy)
    // includes it; the controller image is threaded via extraConfig.
    const warnings: IngressValidationWarning[] = [];
    const image = typeof extra.controllerImage === 'string' ? extra.controllerImage : '';
    const rateLimited = config.domains.filter((d) => d.protection?.rateLimit);
    if (rateLimited.length > 0 && (image === '' || image === 'caddy:2-alpine')) {
      warnings.push({
        path: 'globalOptions.extraConfig.controllerImage',
        message:
          `${rateLimited.length} route(s) carry a rate limit, but the controller image is the stock ` +
          'caddy:2-alpine — rate_limit needs the swarmy Caddy build (docker/caddy-swarmy, ' +
          'xcaddy --with github.com/mholt/caddy-ratelimit). Set a custom controller image.',
      });
    }
    // Edge-per-node REQUIRES the swarmy build: distributed cert storage
    // (caddy-storage-redis) is what stops N per-node Caddys from racing ACME
    // (duplicate orders, rate limits, unanswerable challenges). Hard error.
    const applyVia = typeof extra.applyVia === 'string' ? extra.applyVia : 'file';
    if (
      applyVia === 'local' &&
      config.globalOptions.haStorage &&
      (image === '' || image === 'caddy:2-alpine')
    ) {
      errors.push({
        path: 'globalOptions.extraConfig.controllerImage',
        message:
          'edge-per-node topology with shared cert storage needs the swarmy Caddy build ' +
          '(docker/caddy-swarmy — compiles caddy-storage-redis); the stock caddy:2-alpine ' +
          'cannot load the `storage redis` block and every node would race ACME issuance.',
      });
    }
    const canaryAndRegion = config.domains.filter(
      (d) => d.canary && d.canary.weightPct > 0 && d.regionUpstreams?.length,
    );
    if (canaryAndRegion.length > 0) {
      warnings.push({
        path: 'domains',
        message:
          `${canaryAndRegion.length} route(s) carry both a live canary and region upstreams — ` +
          'weighted (canary) and first (region) lb policies cannot combine in one reverse_proxy, ' +
          'so the canary wins and region-local preference is suspended until the rollout completes.',
      });
    }
    if (errors.length) return { ok: false, errors, warnings: warnings.length ? warnings : undefined };
    return warnings.length ? { ok: true, warnings } : { ok: true };
  }

  render(config: IngressConfig): RenderedConfig {
    const contents = buildCaddyfile(config);
    const extra = config.globalOptions.extraConfig as Record<string, unknown>;
    const applyVia = typeof extra.applyVia === 'string' ? extra.applyVia : 'file';
    // Edge-per-node topology (geo-edge): the agent writes the Caddyfile to a
    // HOST path bind-mounted (ro) into this node's edge Caddy task and execs
    // `caddy reload` inside it. No admin API, no cluster VIP — per-node config.
    if (applyVia === 'local') {
      return {
        driver: 'caddy',
        files: [{ path: CADDY_EDGE_HOST_CONFIG, contents, mode: 0o644 }],
        serviceLabels: [],
        localReload: {
          service: CADDY_EDGE_SERVICE,
          command: ['caddy', 'reload', '--config', CADDY_CONFIG_PATH, '--adapter', 'caddyfile'],
        },
        summary: `Caddy edge — ${config.domains.length} route(s)` +
          (config.localRegion ? ` (region ${config.localRegion})` : ''),
      };
    }
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
    // Geo-edge: when the dispatch exposes region-aware targets AND any route
    // carries region upstreams, render PER NODE so each Caddy prefers its own
    // region. Otherwise the pre-rendered config fans out unchanged (legacy
    // path stays byte-identical).
    const regional =
      dispatch.resolveTargets !== undefined &&
      config.domains.some((d) => d.regionUpstreams?.length);
    let nodeCount: number;
    if (regional && dispatch.resolveTargets) {
      const targets = await dispatch.resolveTargets(config.orgId, config.targetNodes);
      const reports = await Promise.all(
        targets.map((t) =>
          dispatch.sendToNode(t.nodeId, this.render({ ...config, localRegion: t.region })),
        ),
      );
      const failed = reports.find((r) => !r.ok);
      if (failed) throw new IngressApplyError(failed.nodeId, failed.message ?? 'apply failed');
      nodeCount = targets.length;
    } else {
      const nodes = await dispatch.resolveTargetNodes(config.orgId, config.targetNodes);
      const reports = await Promise.all(nodes.map((n) => dispatch.sendToNode(n, rendered)));
      const failed = reports.find((r) => !r.ok);
      if (failed) throw new IngressApplyError(failed.nodeId, failed.message ?? 'apply failed');
      nodeCount = nodes.length;
    }
    return {
      driver: 'caddy',
      healthy: true,
      activeDomains: config.domains.map((d) => d.domain),
      certs: [],
      lastAppliedAt: new Date().toISOString(),
      message: `applied to ${nodeCount} node(s)`,
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
