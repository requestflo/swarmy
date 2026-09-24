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
/**
 * swarmy's own Caddy build (docker/caddy-swarmy, published by
 * .github/workflows/images.yml): stock Caddy + rate_limit, cache,
 * maxmind_geolocation and the `storage s3` shared cert store. The default image
 * for BOTH topologies — the installer and every node already pull public GHCR.
 */
export const SWARMY_CADDY_IMAGE = 'ghcr.io/requestflo/caddy-swarmy:latest';

/**
 * Whether `image` is a plugin-less stock Caddy (`caddy`, `caddy:2-alpine`,
 * `docker.io/library/caddy:…`). Empty = unknown ⇒ treated as stock (the safe,
 * loud answer). Pure.
 */
export function isStockCaddyImage(image: string): boolean {
  if (image === '') return true;
  const repo = image.split('@')[0]!.replace(/:[^/:]+$/, '');
  return repo === 'caddy' || repo === 'library/caddy' || repo === 'docker.io/library/caddy';
}

/** Port the Caddy admin API listens on inside the controller. */
export const CADDY_ADMIN_PORT = 2019;
/** Caddyfile path on the node / controller bind mount. */
export const CADDY_CONFIG_PATH = '/etc/caddy/Caddyfile';
/**
 * Edge-per-node service name (global mode, host-mode 80/443 — geo-edge). The
 * SAME name as the replicated controller on purpose: exactly one swarmy Caddy
 * service exists per swarm, whichever topology is live, so status/runtime,
 * task discovery and the cert volumes are shared across a topology swap.
 */
export const CADDY_EDGE_SERVICE = 'swarmy-ingress-caddy';

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
    const stockImage = isStockCaddyImage(image);
    const rateLimited = config.domains.filter((d) => d.protection?.rateLimit);
    if (rateLimited.length > 0 && stockImage) {
      warnings.push({
        path: 'globalOptions.extraConfig.controllerImage',
        message:
          `${rateLimited.length} route(s) carry a rate limit, but the controller image is the stock ` +
          'caddy:2-alpine — rate_limit needs the swarmy Caddy build (docker/caddy-swarmy, ' +
          'xcaddy --with github.com/mholt/caddy-ratelimit). Set a custom controller image.',
      });
    }
    // Shared cert storage REQUIRES the swarmy build: the `storage s3` module
    // (techknowlogick/certmagic-s3) is compiled in there, and a stock image
    // rejects the whole config at load. Hard error.
    const applyVia = typeof extra.applyVia === 'string' ? extra.applyVia : 'file';
    if (config.globalOptions.certStorage && stockImage) {
      errors.push({
        path: 'globalOptions.extraConfig.controllerImage',
        message:
          'shared certificate storage needs the swarmy Caddy build (docker/caddy-swarmy — ' +
          'compiles certmagic-s3); the stock caddy image cannot load the `storage s3` block. ' +
          'Clear the custom controller image to use the default swarmy build.',
      });
    }
    // Response caching is also plugin-borne (caddyserver/cache-handler) — same
    // deal as rate_limit: renders fine, stock image rejects the config at load.
    const cached = config.domains.filter((d) => d.protection?.cache && !d.cold);
    if (cached.length > 0 && stockImage) {
      warnings.push({
        path: 'globalOptions.extraConfig.controllerImage',
        message:
          `${cached.length} route(s) carry a response cache, but the controller image is the stock ` +
          'caddy:2-alpine — the cache directive needs the swarmy Caddy build (docker/caddy-swarmy, ' +
          'xcaddy --with github.com/caddyserver/cache-handler). Set a custom controller image.',
      });
    }
    // Wildcards can only be issued over DNS-01: without swarmy DNS serving the
    // zone (or a BYO provider token) Caddy would retry an impossible order.
    const unsolvedWildcards = [
      ...new Set(
        config.domains
          .filter((d) => d.tls === 'auto' && d.domain.startsWith('*.') && !config.dnsChallenge?.hosts[d.domain])
          .map((d) => d.domain),
      ),
    ];
    if (unsolvedWildcards.length > 0) {
      warnings.push({
        path: 'dnsChallenge',
        message:
          `${unsolvedWildcards.join(', ')}: a wildcard certificate needs ACME DNS-01 — add the zone to swarmy DNS ` +
          'and point its NS records at swarmy (recommended), or add a DNS provider token for it.',
      });
    }
    const dnsSolved = Object.values(config.dnsChallenge?.hosts ?? {});
    if (dnsSolved.length > 0 && stockImage) {
      errors.push({
        path: 'globalOptions.extraConfig.controllerImage',
        message:
          'wildcard certificates (DNS-01) need the swarmy Caddy build (docker/caddy-swarmy — compiles the ' +
          '`dns swarmy` and `dns cloudflare` providers); the stock caddy image cannot load them.',
      });
    }
    const coldCached = config.domains.filter((d) => d.protection?.cache && d.cold);
    if (coldCached.length > 0) {
      warnings.push({
        path: 'domains',
        message:
          `${coldCached.length} scale-to-zero route(s) carry a response cache — a cold route's ` +
          'response is the activator wake redirect, so caching is skipped until the route is warm.',
      });
    }
    // Country rules render as NOTHING without an mmdb path — a half-configured
    // geo rule must degrade to "not enforced + loud warning", never a lockout.
    const geoRouted = config.domains.filter(
      (d) =>
        (d.protection?.countryAllow?.length ?? 0) > 0 || (d.protection?.countryDeny?.length ?? 0) > 0,
    );
    const geoipMmdbPath = typeof extra.geoipMmdbPath === 'string' ? extra.geoipMmdbPath : '';
    if (geoRouted.length > 0 && geoipMmdbPath === '') {
      warnings.push({
        path: 'globalOptions.extraConfig.geoipMmdbPath',
        message:
          `${geoRouted.length} route(s) carry country allow/deny rules, but no GeoIP database path ` +
          'is configured (extraConfig.geoipMmdbPath) — the rules are NOT enforced. Mount a country ' +
          'mmdb into the ingress container and set the path.',
      });
    }
    if (geoRouted.length > 0 && geoipMmdbPath !== '' && stockImage) {
      warnings.push({
        path: 'globalOptions.extraConfig.controllerImage',
        message:
          `${geoRouted.length} route(s) carry country allow/deny rules, but the controller image is ` +
          'the stock caddy:2-alpine — maxmind_geolocation needs the swarmy Caddy build ' +
          '(docker/caddy-swarmy, xcaddy --with github.com/porech/caddy-maxmind-geolocation). ' +
          'Set a custom controller image.',
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
    // Edge-per-node WITHOUT shared storage: every node obtains its own
    // certificates. Under geo-DNS that is fragile — Let's Encrypt validates
    // from several vantage points, each steered to ITS nearest edge, and only
    // the node that placed the order holds the HTTP-01/TLS-ALPN-01 token, so a
    // new host's first issuance can fail until shared storage (certmagic's
    // distributed challenge solving) or DNS-01 is in place. Certs already on a
    // node's data volume keep serving. Non-blocking, but loud.
    if (applyVia === 'local' && !config.globalOptions.certStorage) {
      warnings.push({
        path: 'globalOptions.certStorage',
        message:
          'edge-per-node without shared certificate storage: each edge node issues its own ' +
          'certificates, and with geo-DNS the ACME validator (multiple vantage points) may be ' +
          'steered to a different node than the one holding the challenge — new hosts can fail ' +
          'to issue. Turn on swarmy object storage so the edges share one certificate pool.',
      });
    }
    if (errors.length) return { ok: false, errors, warnings: warnings.length ? warnings : undefined };
    return warnings.length ? { ok: true, warnings } : { ok: true };
  }

  render(config: IngressConfig): RenderedConfig {
    const contents = buildCaddyfile(config);
    const extra = config.globalOptions.extraConfig as Record<string, unknown>;
    const applyVia = typeof extra.applyVia === 'string' ? extra.applyVia : 'file';
    // Edge-per-node topology (geo-edge): the agent on EACH node running an
    // edge task writes this node's (region-aware) Caddyfile INSIDE its local
    // task over the docker socket and execs `caddy reload` there — the same
    // delivery as the controller's `exec` path. No host files (a container
    // agent can't write the host FS), no admin API, no cluster VIP.
    if (applyVia === 'local') {
      return {
        driver: 'caddy',
        files: [],
        serviceLabels: [],
        localReload: {
          service: CADDY_EDGE_SERVICE,
          file: { path: CADDY_CONFIG_PATH, contents },
          command: ['caddy', 'reload', '--config', CADDY_CONFIG_PATH, '--adapter', 'caddyfile'],
        },
        summary: `Caddy edge — ${config.domains.length} route(s)` +
          (config.localRegion ? ` (region ${config.localRegion})` : ''),
      };
    }
    // Replicated-controller topology (the default): the agent on the node that
    // hosts the controller task writes the Caddyfile INTO that task and execs
    // `caddy reload` there. Needs no overlay membership for the agent, no
    // published admin port, and no host bind mount — only the docker socket the
    // agent already has. Nothing is written on the agent host (`files` empty).
    if (applyVia === 'exec') {
      return {
        driver: 'caddy',
        files: [],
        serviceLabels: [],
        localReload: {
          service: CADDY_CONTROLLER_SERVICE,
          file: { path: CADDY_CONFIG_PATH, contents },
          command: ['caddy', 'reload', '--config', CADDY_CONFIG_PATH, '--adapter', 'caddyfile'],
        },
        summary: `Caddy — ${config.domains.length} route(s): ${
          config.domains.map((d) => d.domain).join(', ') || 'none'
        }`,
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
      assertHasTargets(rendered, targets.length);
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
      assertHasTargets(rendered, nodes.length);
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

/**
 * An in-task apply (`localReload`: edge-per-node or the exec'd controller) with
 * ZERO target nodes means no Caddy task is running anywhere — nothing is
 * serving. That must fail loudly, never report "applied to 0 node(s)" as
 * healthy (the always-green-badge bug).
 */
function assertHasTargets(rendered: RenderedConfig, count: number): void {
  if (count > 0 || !rendered.localReload) return;
  throw new IngressApplyError(
    '(none)',
    `no running ${rendered.localReload.service} task — the ingress controller is not up`,
  );
}
