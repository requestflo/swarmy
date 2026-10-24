import type { DomainRoute, IngressConfig, IngressValidationWarning } from './types';

/**
 * Which edge serves a route — pure, consulted by every driver's render so a
 * route is only ever rendered by the driver that is meant to carry it.
 *
 * The owning service's declared exposure (`swarmy.expose`, copied onto each
 * route as `expose`) wins over everything: no route — hand-written or an
 * automatic address — can widen what the service declared.
 *   - `private` / `mesh` → withheld: no driver renders a public route.
 *   - `tunnel` → only the Cloudflare Tunnel serves it; the public edge never does.
 * Then the route's own `driver` override, which can only NARROW the path:
 *   - `cloudflared` → through the tunnel instead of the public edge (a Caddy
 *     org with a tunnel configured runs both — see {@link tunnelSideConfig});
 *   - `none` → swarmy renders nothing for it (you route that host yourself).
 * Anything else — `caddy`, or a driver that no longer exists (traefik, nginx,
 * haproxy) — is the org's driver: the public edge is an org-wide choice.
 */

/** The tunnel driver's registry name. */
export const TUNNEL_DRIVER = 'cloudflared';

/** Override values that move a route off the org's driver. */
const OVERRIDES: ReadonlySet<string> = new Set([TUNNEL_DRIVER, 'none']);

export type RouteChannel = { driver: string } | { withheld: 'private' | 'mesh' };

/** The driver that serves `route`, or why no public route may exist. */
export function routeChannel(route: Pick<DomainRoute, 'expose' | 'driver'>, defaultDriver: string): RouteChannel {
  if (route.expose === 'private' || route.expose === 'mesh') return { withheld: route.expose };
  if (route.expose === 'tunnel') return { driver: TUNNEL_DRIVER };
  if (route.driver && OVERRIDES.has(route.driver)) return { driver: route.driver };
  return { driver: defaultDriver };
}

/** The driver routes fall back to: the org's own (a render may run as another). */
function orgDriver(config: IngressConfig): string {
  return config.defaultDriver ?? config.driver;
}

/** True when `driver` is the one that renders `route` for this org. */
export function servedBy(route: DomainRoute, config: IngressConfig, driver: string): boolean {
  const ch = routeChannel(route, orgDriver(config));
  return 'driver' in ch && ch.driver === driver;
}

/**
 * The config as `driver` must render it: only the routes that driver serves,
 * and no www redirect onto a host it no longer serves. Returns the SAME object
 * when nothing is filtered, so undeclared configs stay byte-identical.
 */
export function scopeToDriver(config: IngressConfig, driver: string): IngressConfig {
  const kept = config.domains.filter((d) => servedBy(d, config, driver));
  if (kept.length === config.domains.length) return config;
  const keptHosts = new Set(kept.map((d) => d.domain));
  const droppedHosts = new Set(config.domains.filter((d) => !keptHosts.has(d.domain)).map((d) => d.domain));
  return {
    ...config,
    domains: kept,
    ...(config.hostRedirects
      ? { hostRedirects: config.hostRedirects.filter((r) => !droppedHosts.has(r.to)) }
      : {}),
  };
}

/**
 * The tunnel half of an org whose edge is NOT the tunnel but some of whose
 * routes go through it (`driver: cloudflared` or `swarmy.expose=tunnel`):
 * the same config rendered as cloudflared, routes still judged against the
 * org's driver. Null when there is nothing to run (no such route, or no
 * tunnel configured — validate() then says the routes are unreachable).
 */
export function tunnelSideConfig(config: IngressConfig): IngressConfig | null {
  if (orgDriver(config) === TUNNEL_DRIVER || !config.globalOptions.tunnel) return null;
  if (!config.domains.some((d) => servedBy(d, config, TUNNEL_DRIVER))) return null;
  return { ...config, driver: TUNNEL_DRIVER, defaultDriver: orgDriver(config) };
}

function hostList(routes: readonly DomainRoute[]): string {
  return [...new Set(routes.map((d) => d.domain))].join(', ');
}

/**
 * Validate() notes for the routes `driver` leaves out on purpose. Non-blocking:
 * a withheld route is the label working as declared, never a render failure.
 */
export function channelWarnings(config: IngressConfig, driver: string): IngressValidationWarning[] {
  const out: IngressValidationWarning[] = [];
  const withheld = config.domains.filter((d) => 'withheld' in routeChannel(d, orgDriver(config)));
  if (withheld.length > 0) {
    out.push({
      path: 'domains',
      message:
        `${hostList(withheld)}: the service is declared private or mesh-only (swarmy.expose), so the edge ` +
        'serves no public route for it. Remove the route, or change the declared mode if it should be public.',
    });
  }
  if (driver !== TUNNEL_DRIVER) {
    const tunnelOnly = config.domains.filter((d) => servedBy(d, config, TUNNEL_DRIVER));
    if (tunnelOnly.length > 0) {
      out.push({
        path: 'domains',
        message:
          `${hostList(tunnelOnly)}: goes through the Cloudflare Tunnel (swarmy.expose=tunnel or the route's driver), ` +
          'so the public edge never serves it' +
          (config.globalOptions.tunnel ? ' — the tunnel does.' : ', and no Cloudflare Tunnel is set up, so it is unreachable.'),
      });
    }
  }
  return out;
}

/** Merge extra warnings into a validate() result (keeps `ok`/`errors`). */
export function withWarnings<T extends { warnings?: IngressValidationWarning[] }>(
  res: T,
  extra: IngressValidationWarning[],
): T {
  if (extra.length === 0) return res;
  return { ...res, warnings: [...(res.warnings ?? []), ...extra] };
}
