import type {
  ExposeMode,
  ExposureDriftView,
  ExposureIntentOverview,
  ExposureIntentRowView,
  ExposureRulesView,
  ExposureViolationView,
  SetExposureRulesInput,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Exposure demo resolvers — the Exposure surface (`/exposure`): the audit
 * table, the rules card, the violations feed and the per-service declared
 * mode (`swarmy.expose`). Return shapes mirror `exposure.service.ts` views
 * exactly (imported from @swarmy/core, never redeclared). Service ids line up
 * with the seeded demo estate so row links land on real service pages. Two
 * teaching moments are seeded: the managed postgres publishes 5432 (the
 * canonical "expected? no." rule violation), and cdn-edge declares `private`
 * while publishing a port (declared-vs-observed drift).
 */

type DemoRules = ExposureRulesView & { enforceDeclaredIntent: boolean };

interface ExposureState {
  rows: ExposureIntentRowView[];
  rules: DemoRules;
}

function getState(store: DemoStore): ExposureState {
  return store.extra.exposure as ExposureState;
}

/** Mirror of `computeExposureDrift` (demo ingress driver is caddy, so any
 *  route under a `tunnel` declaration drifts). */
function computeDrift(row: ExposureIntentRowView): ExposureDriftView | null {
  const d = row.declared;
  if (!d) return null;
  const ports = row.publishedPorts.map((p) => `:${p.published}/${p.protocol}`).join(', ');
  const domains = row.domains.join(', ');
  switch (d) {
    case 'private':
      if (row.exposure === 'public-port') {
        return { level: 'violation', message: `declared private but publishes ${ports} to the world` };
      }
      if (row.exposure === 'public-domain') {
        return { level: 'violation', message: `declared private but routed publicly via ${domains}` };
      }
      return null;
    case 'mesh':
      if (row.publishedPorts.length > 0) {
        return { level: 'violation', message: `declared mesh-only but publishes ${ports} to the world` };
      }
      if (row.domains.length > 0) {
        return { level: 'violation', message: `declared mesh-only but routed publicly via ${domains}` };
      }
      return null;
    case 'tunnel':
      if (row.publishedPorts.length > 0) {
        return {
          level: 'violation',
          message: `declared tunnel but publishes ${ports} directly — traffic bypasses the tunnel`,
        };
      }
      if (row.domains.length > 0) {
        return {
          level: 'violation',
          message: `declared tunnel but ${domains} is served by caddy, not cloudflared`,
        };
      }
      return null;
    case 'public':
      if (row.publishedPorts.length === 0 && row.domains.length === 0) {
        return {
          level: 'warning',
          message: 'declared public but has no route or published port — unreachable from the internet',
        };
      }
      return null;
  }
}

function row(
  over: Partial<ExposureIntentRowView> &
    Pick<ExposureIntentRowView, 'serviceId' | 'serviceName' | 'stack'>,
): ExposureIntentRowView {
  const base: ExposureIntentRowView = {
    exposure: 'private',
    managedKind: null,
    publishedPorts: [],
    domains: [],
    details: ['no public surface'],
    declared: null,
    drift: null,
    ...over,
  };
  base.drift = computeDrift(base);
  return base;
}

/** Mirror of `evaluateEstateRules` + `driftViolations` — audit × rules. */
function computeViolations(state: ExposureState): ExposureViolationView[] {
  const out: ExposureViolationView[] = [];
  for (const r of state.rows) {
    if (r.publishedPorts.length > 0) {
      if (state.rules.noPublicPortsOnManagedData && r.managedKind) {
        const ports = r.publishedPorts.map((p) => p.published).join(', ');
        out.push({
          rule: 'exposure/no-public-ports-on-managed-data',
          severity: 'block',
          serviceId: r.serviceId,
          serviceName: r.serviceName,
          stack: r.stack,
          message: `Managed ${r.managedKind} service ${r.serviceName} publishes port ${ports} to the world.`,
          fixHint: `Remove published port ${ports} from ${r.serviceName} — apps reach it over private networking (attach injects the connection URL).`,
        });
      }
      if (state.rules.noPublicUdp) {
        for (const p of r.publishedPorts) {
          if (p.protocol !== 'udp') continue;
          out.push({
            rule: 'exposure/no-public-udp',
            severity: 'block',
            serviceId: r.serviceId,
            serviceName: r.serviceName,
            stack: r.stack,
            message: `${r.serviceName} publishes UDP port ${p.published} — UDP exposure needs explicit approval.`,
            fixHint: `Remove the UDP publish on :${p.published}, or redeploy with an explicit override to approve it.`,
          });
        }
      }
    }
    if (r.drift && r.declared) {
      out.push({
        rule: 'exposure/declared-drift',
        severity: r.drift.level === 'violation' ? 'block' : 'warn',
        serviceId: r.serviceId,
        serviceName: r.serviceName,
        stack: r.stack,
        message: `${r.serviceName} is ${r.drift.message}.`,
        fixHint:
          r.drift.level === 'violation'
            ? `Remove the public surface from ${r.serviceName}, or change its declared mode from "${r.declared}" if the exposure is intended.`
            : `Add an ingress route (or published port) to ${r.serviceName}, or change its declared mode from "${r.declared}".`,
      });
    }
  }
  return out;
}

export const exposure: DomainResolvers = {
  seed: (store) => {
    const rows: ExposureIntentRowView[] = [
      row({
        serviceId: 'svc-web',
        serviceName: 'web',
        stack: 'storefront',
        exposure: 'public-domain',
        domains: ['shop.northwind.dev'],
        details: ['shop.northwind.dev → :3000 (tls auto)'],
        declared: 'public',
      }),
      row({
        serviceId: 'svc-api',
        serviceName: 'api',
        stack: 'storefront',
        exposure: 'public-domain',
        domains: ['api.northwind.dev'],
        details: ['api.northwind.dev → :8080 (tls auto)'],
        declared: 'public',
      }),
      // Seeded drift: declared private, but a port is published.
      row({
        serviceId: 'svc-cdn',
        serviceName: 'cdn-edge',
        stack: 'storefront',
        exposure: 'public-port',
        publishedPorts: [{ target: 8081, published: 8081, protocol: 'tcp', mode: null }],
        details: [':8081 → 8081/tcp published'],
        declared: 'private',
      }),
      row({
        serviceId: 'svc-checkout',
        serviceName: 'checkout',
        stack: 'storefront',
        declared: 'mesh',
      }),
      // The seeded rule violation: a managed postgres with a published port.
      row({
        serviceId: 'svc-postgres',
        serviceName: 'postgres',
        stack: 'data',
        exposure: 'public-port',
        managedKind: 'db',
        publishedPorts: [{ target: 5432, published: 5432, protocol: 'tcp', mode: null }],
        details: [':5432 → 5432/tcp published'],
      }),
      row({
        serviceId: 'svc-redis',
        serviceName: 'redis',
        stack: 'data',
        exposure: 'internal-managed',
        managedKind: 'cache',
        details: ['managed cache — private networking only'],
      }),
      row({ serviceId: 'svc-nats', serviceName: 'nats', stack: 'data' }),
      row({ serviceId: 'svc-worker', serviceName: 'worker', stack: 'data' }),
      row({
        serviceId: 'svc-grafana',
        serviceName: 'grafana',
        stack: 'platform',
        exposure: 'public-domain',
        domains: ['grafana.northwind.dev'],
        details: ['grafana.northwind.dev → :3001 (tls auto)'],
      }),
      row({ serviceId: 'svc-prometheus', serviceName: 'prometheus', stack: 'platform' }),
      row({ serviceId: 'svc-loki', serviceName: 'loki', stack: 'platform' }),
      row({ serviceId: 'svc-tunnel', serviceName: 'cloudflared', stack: '(ungrouped)' }),
    ];
    store.extra.exposure = {
      rows,
      rules: {
        noPublicPortsOnManagedData: true,
        noPublicUdp: true,
        warnOnNewPublishedPorts: true,
        enforceDeclaredIntent: true,
        enforce: false,
      },
    } satisfies ExposureState;
  },

  handlers: {
    'exposure.overview': (_i, s): ExposureIntentOverview => {
      const st = getState(s);
      let pub = 0;
      let priv = 0;
      let managed = 0;
      for (const r of st.rows) {
        if (r.exposure === 'public-port' || r.exposure === 'public-domain') pub += 1;
        else if (r.exposure === 'internal-managed') managed += 1;
        else priv += 1;
      }
      return {
        rows: [...st.rows].sort((a, b) =>
          `${a.stack}/${a.serviceName}`.localeCompare(`${b.stack}/${b.serviceName}`),
        ),
        counts: { public: pub, private: priv, managed },
        auditedAt: new Date().toISOString(),
      };
    },

    'exposure.rules': (_i, s): DemoRules => ({ ...getState(s).rules }),

    'exposure.setRules': (i, s): DemoRules => {
      const st = getState(s);
      const patch = i as SetExposureRulesInput & { enforceDeclaredIntent?: boolean };
      st.rules = {
        noPublicPortsOnManagedData:
          patch.noPublicPortsOnManagedData ?? st.rules.noPublicPortsOnManagedData,
        noPublicUdp: patch.noPublicUdp ?? st.rules.noPublicUdp,
        warnOnNewPublishedPorts:
          patch.warnOnNewPublishedPorts ?? st.rules.warnOnNewPublishedPorts,
        enforceDeclaredIntent: patch.enforceDeclaredIntent ?? st.rules.enforceDeclaredIntent,
        enforce: patch.enforce ?? st.rules.enforce,
      };
      return { ...st.rules };
    },

    'exposure.setMode': (i, s): { id: string; mode: ExposeMode | null } => {
      const st = getState(s);
      const input = i as { id: string; mode: ExposeMode | null };
      const target = st.rows.find((r) => r.serviceId === input.id);
      if (target) {
        target.declared = input.mode;
        target.drift = computeDrift(target);
      }
      return { id: input.id, mode: input.mode };
    },

    'exposure.violations': (_i, s): ExposureViolationView[] => computeViolations(getState(s)),
  },
};
