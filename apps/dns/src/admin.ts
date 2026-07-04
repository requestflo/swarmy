import type { DnsServerConfig } from './config';
import { log, logError } from './config';
import type { DnsMetrics } from './metrics';
import type { SnapshotStore } from './store';
import type { GeoIpManager } from './geoip-manager';

/**
 * Admin API — how the agent (and only the agent) talks to swarmy-dns:
 *
 *   POST /v1/snapshot   bearer-authed versioned bundle push (dns.apply)
 *   GET  /v1/status     serving version, zones, qps counters, geoip state
 *   GET  /healthz       liveness (also used by the swarm healthcheck)
 *
 * SECURITY: the port is host-mode published (binds 0.0.0.0), so pushes are
 * bearer-token-gated and we fail CLOSED when no token is configured — the
 * only exception is the explicit local-dev env escape hatch.
 */
export function startAdminServer(
  config: DnsServerConfig,
  store: SnapshotStore,
  metrics: DnsMetrics,
  geoip: GeoIpManager,
): { close(): void } {
  const authorized = (req: Request): boolean => {
    if (config.adminToken) {
      return req.headers.get('authorization') === `Bearer ${config.adminToken}`;
    }
    return config.allowInsecureAdmin;
  };

  const server = Bun.serve({
    hostname: config.host,
    port: config.adminPort,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return Response.json({ ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/v1/status') {
        return Response.json({
          version: store.version,
          zones: store.current?.zones.map((z) => ({ zone: z.zone, serial: z.serial })) ?? [],
          generatedAt: store.current?.generatedAt,
          metrics,
          geoip: geoip.status(),
        });
      }

      if (req.method === 'POST' && url.pathname === '/v1/snapshot') {
        if (!authorized(req)) {
          logError('rejected snapshot push: unauthorized');
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        const result = await store.apply(body);
        if (!result.ok) {
          const stale = result.error.startsWith('stale');
          return Response.json(
            { applied: false, error: result.error, version: store.version },
            { status: stale ? 409 : 400 },
          );
        }
        return Response.json({ applied: true, version: result.version, zones: result.zones });
      }

      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  log(`admin api listening on ${config.host}:${config.adminPort}`);
  return { close: () => server.stop(true) };
}
