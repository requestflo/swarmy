import type { TlsMode } from '@swarmy/core';
import type { RenderedConfig } from '@swarmy/core/protocol';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Ingress demo resolvers — the Networking surface (driver chooser + rendered-config
 * preview, domains list, Caddy HA, on-demand TLS, Cloudflare tunnel card). Covers
 * the `ingress` router and the nested `ingress.tunnels` router.
 *
 * State lives in `store.extra.ingress`; mutations flip booleans / push rows so the
 * page reflects changes after it invalidates and re-reads. Secrets are never stored
 * in cleartext-meaningful ways here — demo mode has no real vault — we just track
 * "configured" flags the way the real views (which never return secrets) do.
 */

/** Driver ids supported by the UI (mirrors `IngressDriverId` in driver-config.ts). */
type IngressDriverId = 'none' | 'caddy' | 'traefik' | 'cloudflared' | 'nginx' | 'haproxy';

/** Mirror of `RouteProtection` (protection-model.ts / packages/ingress/src/types.ts). */
interface RouteProtection {
  rateLimit?: { requests: number; windowSeconds: number; key: 'ip' | 'header'; header?: string };
  ipAllow: string[];
  ipDeny: string[];
  bodyMaxSize?: string;
  blockBots: boolean;
  requiredHeaders: { name: string; value?: string }[];
}

/** Mirror of the controller's `DomainView` (ingress.service.ts). */
interface DomainView {
  id: string;
  host: string;
  serviceId: string;
  serviceName: string;
  /** Docker stack the owning service belongs to (`(ungrouped)` when standalone). */
  stack: string;
  targetPort: number;
  tls: TlsMode;
  pathPrefix: string | null;
  ingressDriver: IngressDriverId | null;
  protection: RouteProtection | null;
  canaryPct: number | null;
}

/** Mirror of the controller's `IngressConfigView` (ingress.service.ts). */
interface IngressConfigView {
  driver: IngressDriverId;
  enabled: boolean;
  targetNodes: string[];
  domainCount: number;
  haConfigured: boolean;
  tunnelConfigured: boolean;
  /** Custom ingress-controller image (null = the stock caddy:2-alpine). */
  controllerImage: string | null;
  updatedAt: string;
}

/** Mirror of the controller's `TunnelView` (tunnel.service.ts). */
interface TunnelView {
  provider: 'cloudflare';
  tunnelId: string | null;
  tunnelName: string;
  accountId: string | null;
  connected: boolean;
  replicas: number;
  domainCount: number;
}

/** The demo ingress world: org config, domain rows, and the Cloudflare tunnel. */
interface IngressState {
  driver: IngressDriverId;
  enabled: boolean;
  targetNodes: string[];
  haConfigured: boolean;
  onDemandTls: boolean;
  onDemandAskUrl: string | null;
  controllerImage: string | null;
  updatedAt: string;
  domains: DomainView[];
  tunnel: {
    tunnelId: string | null;
    tunnelName: string;
    accountId: string | null;
    /** Has a run token on file (CF connector live). */
    connected: boolean;
    /** Has any tunnel block at all (manual or created). */
    configured: boolean;
    replicas: number;
  } | null;
}

const VALID_DRIVERS: ReadonlySet<IngressDriverId> = new Set<IngressDriverId>([
  'none',
  'caddy',
  'traefik',
  'cloudflared',
  'nginx',
  'haproxy',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function getState(store: DemoStore): IngressState {
  return store.extra.ingress as IngressState;
}

/** `store.stacks` carries id→name; services only know the id. Mirrors the real
 *  resolver's `service.stack` (Docker namespace NAME, UNGROUPED when standalone). */
function stackName(store: DemoStore, stackId: string | null): string {
  return store.stacks.find((st) => st.id === stackId)?.name ?? '(ungrouped)';
}

/** Build the summary view the Networking page header + badges read. */
function toConfigView(st: IngressState): IngressConfigView {
  return {
    driver: st.driver,
    enabled: st.enabled,
    targetNodes: st.targetNodes,
    domainCount: st.domains.length,
    haConfigured: st.haConfigured,
    tunnelConfigured: Boolean(st.tunnel?.tunnelId),
    controllerImage: st.controllerImage,
    updatedAt: st.updatedAt,
  };
}

function toTunnelView(st: IngressState): TunnelView | null {
  const t = st.tunnel;
  if (!t) return null;
  return {
    provider: 'cloudflare',
    tunnelId: t.tunnelId,
    tunnelName: t.tunnelName,
    accountId: t.accountId,
    connected: t.connected,
    replicas: t.replicas,
    domainCount: st.domains.length,
  };
}

/**
 * Render a believable `RenderedConfig` for the preview pane. The DriverPanel only
 * reads `summary` and `files[].path/contents`, but we fill the full protocol shape
 * so the value matches what `previewConfig` actually returns.
 */
function renderPreview(st: IngressState, driver: IngressDriverId): RenderedConfig {
  const routes = st.domains.map((d) => ({ host: d.host, service: d.serviceName, port: d.targetPort, tls: d.tls }));
  const base: RenderedConfig = {
    driver,
    files: [],
    serviceLabels: [],
    summary: '',
  };

  if (driver === 'caddy') {
    const body =
      routes
        .map(
          (r) =>
            `${r.host} {\n\treverse_proxy ${r.service}:${r.port}\n${
              r.tls === 'off' ? '\ttls off\n' : r.tls === 'auto' ? '\ttls internal off\n' : ''
            }}`,
        )
        .join('\n\n') || '# no domains routed yet';
    return {
      ...base,
      files: [{ path: '/etc/caddy/Caddyfile', mode: 0o644, contents: body }],
      reloadCommand: ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
      summary: `Caddy · ${routes.length} site(s) · automatic HTTPS${st.haConfigured ? ' · HA storage (Redis)' : ''}${
        st.onDemandTls ? ' · on-demand TLS' : ''
      }`,
    };
  }

  if (driver === 'traefik') {
    return {
      ...base,
      serviceLabels: routes.map((r) => ({
        service: r.service,
        labels: {
          'traefik.enable': 'true',
          [`traefik.http.routers.${r.service}.rule`]: `Host(\`${r.host}\`)`,
          [`traefik.http.services.${r.service}.loadbalancer.server.port`]: String(r.port),
        },
        removeLabelKeys: [],
      })),
      summary: `Traefik · ${routes.length} router(s) · label-based routing`,
    };
  }

  if (driver === 'cloudflared') {
    const rules = routes.map((r) => `  - hostname: ${r.host}\n    service: http://${r.service}:${r.port}`).join('\n');
    return {
      ...base,
      files: [
        {
          path: '/etc/cloudflared/config.yml',
          mode: 0o644,
          contents: `tunnel: ${st.tunnel?.tunnelId ?? '<tunnel-id>'}\ningress:\n${rules || '  - service: http_status:404'}\n  - service: http_status:404`,
        },
      ],
      summary: `Cloudflare Tunnel · ${routes.length} hostname(s) · ${st.tunnel?.connected ? 'connector live' : 'not connected'}`,
    };
  }

  if (driver === 'nginx') {
    const body =
      routes
        .map(
          (r) =>
            `server {\n\tlisten 443 ssl;\n\tserver_name ${r.host};\n\tlocation / { proxy_pass http://${r.service}:${r.port}; }\n}`,
        )
        .join('\n\n') || '# no domains routed yet';
    return {
      ...base,
      files: [{ path: '/etc/nginx/conf.d/swarmy.conf', mode: 0o644, contents: body }],
      reloadCommand: ['nginx', '-s', 'reload'],
      summary: `nginx · ${routes.length} server block(s) · external ACME companion`,
    };
  }

  if (driver === 'haproxy') {
    const acls = routes.map((r) => `\tacl host_${r.service} hdr(host) -i ${r.host}\n\tuse_backend be_${r.service} if host_${r.service}`).join('\n');
    const backends = routes.map((r) => `backend be_${r.service}\n\tserver s1 ${r.service}:${r.port} check`).join('\n\n');
    return {
      ...base,
      files: [
        {
          path: '/etc/haproxy/haproxy.cfg',
          mode: 0o644,
          contents: `frontend fe_https\n\tbind :443\n${acls || '\t# no domains routed yet'}\n\n${backends}`,
        },
      ],
      reloadCommand: ['haproxy', '-sf', '$(pidof haproxy)', '-f', '/etc/haproxy/haproxy.cfg'],
      summary: `HAProxy · ${routes.length} backend(s) · SNI routing`,
    };
  }

  return { ...base, summary: 'None mode · swarmy tracks domains but writes nothing to nodes.' };
}

export const ingress: DomainResolvers = {
  handlers: {
    'ingress.getConfig': (_i, s): IngressConfigView => toConfigView(getState(s)),

    'ingress.listDrivers': (): IngressDriverId[] => ['none', 'caddy', 'traefik', 'cloudflared', 'nginx', 'haproxy'],

    'ingress.listDomains': (i, s): DomainView[] => {
      const stack = (i as { stack?: string } | undefined)?.stack;
      const rows = getState(s).domains;
      return stack ? rows.filter((d) => d.stack === stack) : rows;
    },

    // Per-app multi-route API (Phase 3): routes derive from this service's domains.
    'ingress.listServiceRoutes': (i, s) => {
      const { serviceId } = i as { serviceId: string };
      return getState(s)
        .domains.filter((d) => d.serviceId === serviceId)
        .map((d) => ({
          host: d.host,
          port: d.targetPort,
          tls: (d.tls === 'custom' ? 'manual' : d.tls) as 'auto' | 'off' | 'manual',
          ...(d.pathPrefix ? { path: d.pathPrefix } : {}),
          ...(d.ingressDriver ? { driver: d.ingressDriver } : {}),
          ...(d.protection ? { protection: d.protection } : {}),
        }));
    },
    'ingress.setServiceRoutes': (i, s) => {
      const b = i as {
        serviceId: string;
        routes: {
          host: string;
          port: number;
          tls?: 'auto' | 'off' | 'manual';
          path?: string;
          driver?: string;
          protection?: RouteProtection;
        }[];
      };
      const st = getState(s);
      const svc = s.services.find((sv) => sv.id === b.serviceId);
      const prior = st.domains.filter((d) => d.serviceId === b.serviceId);
      const others = st.domains.filter((d) => d.serviceId !== b.serviceId);
      st.domains = [
        ...b.routes.map((r): DomainView => {
          const match = prior.find((d) => d.host === r.host && (d.pathPrefix ?? null) === (r.path ?? null));
          return {
            id: match?.id ?? rid('dom'),
            host: r.host,
            serviceId: b.serviceId,
            serviceName: svc?.name ?? b.serviceId,
            stack: stackName(s, svc?.stackId ?? null),
            targetPort: r.port,
            tls: (r.tls === 'manual' ? 'custom' : (r.tls ?? 'auto')) as TlsMode,
            pathPrefix: r.path ?? null,
            ingressDriver:
              r.driver && VALID_DRIVERS.has(r.driver as IngressDriverId) && r.driver !== 'none'
                ? (r.driver as IngressDriverId)
                : null,
            protection: r.protection ?? null,
            canaryPct: match?.canaryPct ?? null,
          };
        }),
        ...others,
      ];
      if (svc) svc.ingressEnabled = b.routes.length > 0;
      st.updatedAt = nowIso();
      return getState(s).domains.filter((d) => d.serviceId === b.serviceId).map((d) => ({ host: d.host, port: d.targetPort, tls: (d.tls === 'custom' ? 'manual' : d.tls) as 'auto' | 'off' | 'manual' }));
    },
    'ingress.detectPorts': (i, s) => {
      const { serviceId } = i as { serviceId: string };
      const svc = s.services.find((sv) => sv.id === serviceId);
      const seen = new Set<string>();
      const out: { port: number; protocol: 'tcp' | 'udp'; source: 'service' | 'container' }[] = [];
      for (const p of svc?.ports ?? []) {
        const protocol: 'tcp' | 'udp' = p.protocol === 'udp' ? 'udp' : 'tcp';
        const key = `${p.target}/${protocol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ port: p.target, protocol, source: 'service' });
      }
      return out;
    },

    'ingress.addDomain': (i, s): DomainView => {
      const b = i as {
        host: string;
        serviceId: string;
        targetPort: number;
        tls?: TlsMode;
        pathPrefix?: string;
        ingressDriver?: IngressDriverId | null;
      };
      const st = getState(s);
      const svc = s.services.find((sv) => sv.id === b.serviceId);
      const serviceName = svc?.name ?? b.serviceId;
      const driverOverride =
        b.ingressDriver && VALID_DRIVERS.has(b.ingressDriver) && b.ingressDriver !== 'none' ? b.ingressDriver : null;
      const row: DomainView = {
        id: rid('dom'),
        host: b.host,
        serviceId: b.serviceId,
        serviceName,
        stack: stackName(s, svc?.stackId ?? null),
        targetPort: b.targetPort,
        tls: b.tls ?? 'auto',
        pathPrefix: b.pathPrefix ?? null,
        ingressDriver: driverOverride,
        protection: null,
        canaryPct: null,
      };
      st.domains = [row, ...st.domains];
      if (svc) svc.ingressEnabled = true;
      st.updatedAt = nowIso();
      return row;
    },

    'ingress.removeDomain': (i, s): { id: string; removed: true } => {
      const { id } = i as { id: string };
      const st = getState(s);
      st.domains = st.domains.filter((d) => d.id !== id);
      st.updatedAt = nowIso();
      return { id, removed: true };
    },

    'ingress.setDriver': (i, s): IngressConfigView => {
      const { driver } = i as { driver: IngressDriverId };
      const st = getState(s);
      if (VALID_DRIVERS.has(driver)) st.driver = driver;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'ingress.setEnabled': (i, s): IngressConfigView => {
      const { enabled } = i as { enabled: boolean };
      const st = getState(s);
      st.enabled = enabled;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'ingress.setControllerImage': (i, s): IngressConfigView => {
      const { image } = i as { image: string | null };
      const st = getState(s);
      st.controllerImage = image;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'ingress.setTargetNodes': (i, s): IngressConfigView => {
      const { nodeIds } = i as { nodeIds: string[] };
      const st = getState(s);
      st.targetNodes = nodeIds;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    /** Idempotent "deploy/converge" — demo mode just bumps updatedAt. */
    'ingress.ensureController': (_i, s): { converged: true } => {
      getState(s).updatedAt = nowIso();
      return { converged: true };
    },

    'ingress.previewConfig': (i, s): RenderedConfig => {
      const st = getState(s);
      const requested = (i as { driver?: IngressDriverId } | undefined)?.driver;
      const driver = requested && VALID_DRIVERS.has(requested) ? requested : st.driver;
      return renderPreview(st, driver);
    },

    'ingress.setHaStorage': (i, s): IngressConfigView => {
      const input = i as { host: string } | null;
      const st = getState(s);
      st.haConfigured = input != null;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'ingress.setOnDemandTls': (i, s): IngressConfigView => {
      const b = i as { enabled: boolean; askUrl?: string };
      const st = getState(s);
      st.onDemandTls = b.enabled;
      st.onDemandAskUrl = b.enabled ? b.askUrl ?? st.onDemandAskUrl : null;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'ingress.setTunnel': (i, s): IngressConfigView => {
      const input = i as {
        accountId?: string;
        tunnelId?: string;
        tunnelName?: string;
        replicas?: number;
        apiToken?: string;
        runToken?: string;
      } | null;
      const st = getState(s);
      if (input == null) {
        st.tunnel = null;
      } else {
        const prev = st.tunnel;
        st.tunnel = {
          tunnelId: input.tunnelId ?? prev?.tunnelId ?? null,
          tunnelName: input.tunnelName ?? prev?.tunnelName ?? 'swarmy',
          accountId: input.accountId ?? prev?.accountId ?? null,
          // A manual save with an apiToken is "configured" but only "connected"
          // once a run token is on file (mirrors the real view's `connected`).
          connected: Boolean(input.runToken) || prev?.connected || false,
          configured: true,
          replicas: input.replicas ?? prev?.replicas ?? 1,
        };
      }
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'ingress.tunnels.list': (_i, s): TunnelView[] => {
      const v = toTunnelView(getState(s));
      return v ? [v] : [];
    },

    'ingress.tunnels.get': (_i, s): TunnelView | null => toTunnelView(getState(s)),

    'ingress.tunnels.create': (i, s): TunnelView => {
      const b = i as { name: string; accountId: string; apiToken: string; replicas?: number };
      const st = getState(s);
      st.tunnel = {
        tunnelId: rid('cf').replace('cf-', ''),
        tunnelName: b.name || 'swarmy',
        accountId: b.accountId,
        connected: true,
        configured: true,
        replicas: b.replicas ?? 1,
      };
      // Creating a tunnel implies the cloudflared driver is the live ingress path.
      st.driver = 'cloudflared';
      st.updatedAt = nowIso();
      const view = toTunnelView(st);
      if (!view) throw new Error('tunnel creation did not persist');
      return view;
    },

    'ingress.tunnels.sync': (i, s): { synced: true; rules: number } => {
      const opts = i as { zoneId?: string } | undefined;
      const st = getState(s);
      if (!st.tunnel?.tunnelId) throw new Error('no tunnel to sync');
      void opts;
      st.updatedAt = nowIso();
      return { synced: true, rules: st.domains.length };
    },

    'ingress.tunnels.delete': (_i, s): { deleted: true } => {
      const st = getState(s);
      st.tunnel = null;
      st.updatedAt = nowIso();
      return { deleted: true };
    },
  },

  seed: (store) => {
    // A coherent slice of the demo cluster: Caddy live, three public hostnames
    // pointed at the ingress-enabled services (web/api/cdn/grafana from data.ts),
    // HA cert storage on, on-demand TLS off, no tunnel yet.
    const state: IngressState = {
      driver: 'caddy',
      enabled: true,
      targetNodes: ['n-mgr-1', 'n-mgr-2'],
      haConfigured: true,
      onDemandTls: false,
      onDemandAskUrl: null,
      controllerImage: null,
      updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      domains: [
        {
          id: 'dom-www',
          host: 'shop.northwind.dev',
          serviceId: 'svc-web',
          serviceName: 'web',
          stack: stackName(store, 's-store'),
          targetPort: 3000,
          tls: 'auto',
          pathPrefix: null,
          ingressDriver: null,
          // A live rate limit — the reason the controller-image note exists.
          protection: {
            rateLimit: { requests: 100, windowSeconds: 60, key: 'ip' },
            ipAllow: [],
            ipDeny: [],
            blockBots: true,
            requiredHeaders: [],
          },
          canaryPct: 10,
        },
        {
          id: 'dom-api',
          host: 'api.northwind.dev',
          serviceId: 'svc-api',
          serviceName: 'api',
          stack: stackName(store, 's-store'),
          targetPort: 8080,
          tls: 'auto',
          pathPrefix: '/v2',
          ingressDriver: null,
          protection: null,
          canaryPct: null,
        },
        {
          id: 'dom-cdn',
          host: 'cdn.northwind.dev',
          serviceId: 'svc-cdn',
          serviceName: 'cdn-edge',
          stack: stackName(store, 's-store'),
          targetPort: 8081,
          tls: 'auto',
          pathPrefix: null,
          ingressDriver: 'cloudflared',
          protection: null,
          canaryPct: null,
        },
        {
          id: 'dom-grafana',
          host: 'metrics.northwind.dev',
          serviceId: 'svc-grafana',
          serviceName: 'grafana',
          stack: stackName(store, 's-platform'),
          targetPort: 3001,
          tls: 'custom',
          pathPrefix: null,
          ingressDriver: null,
          protection: {
            rateLimit: undefined,
            ipAllow: ['10.0.0.0/8'],
            ipDeny: [],
            blockBots: false,
            requiredHeaders: [],
          },
          canaryPct: null,
        },
      ],
      tunnel: null,
    };
    store.extra.ingress = state;
  },
};
