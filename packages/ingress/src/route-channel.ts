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
 *   - `public` / undeclared → the org's driver.
 */

/** The tunnel driver's registry name. */
export const TUNNEL_DRIVER = 'cloudflared';

export type RouteChannel = { driver: string } | { withheld: 'private' | 'mesh' };

/** The driver that serves `route`, or why no public route may exist. */
export function routeChannel(route: Pick<DomainRoute, 'expose'>, defaultDriver: string): RouteChannel {
  if (route.expose === 'private' || route.expose === 'mesh') return { withheld: route.expose };
  if (route.expose === 'tunnel') return { driver: TUNNEL_DRIVER };
  return { driver: defaultDriver };
}

/** The driver routes fall back to: the org's own (a render may run as another). */
function orgDriver(config: IngressConfig): string {
  return config.driver;
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
          `${hostList(tunnelOnly)}: tunnel-only (swarmy.expose=tunnel), so the public edge never serves it` +
          (config.globalOptions.tunnel ? '.' : ', and no Cloudflare Tunnel is set up, so it is unreachable.'),
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
