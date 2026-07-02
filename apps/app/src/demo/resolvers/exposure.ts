import type {
  ExposureOverview,
  ExposureRowView,
  ExposureRulesView,
  ExposureViolationView,
  SetExposureRulesInput,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Exposure demo resolvers — the Exposure surface (`/exposure`): the audit
 * table, the rules card and the violations feed. Return shapes mirror
 * `exposure.service.ts` views exactly (imported from @swarmy/core, never
 * redeclared). Service ids line up with the seeded demo estate so row links
 * land on real service pages. One violation is seeded: the managed postgres
 * publishes 5432 — the wishlist's canonical "expected? no." case.
 */

interface ExposureState {
  rows: ExposureRowView[];
  rules: ExposureRulesView;
}

function getState(store: DemoStore): ExposureState {
  return store.extra.exposure as ExposureState;
}

function row(
  over: Partial<ExposureRowView> & Pick<ExposureRowView, 'serviceId' | 'serviceName' | 'stack'>,
): ExposureRowView {
  return {
    exposure: 'private',
    managedKind: null,
    publishedPorts: [],
    domains: [],
    details: ['no public surface'],
    ...over,
  };
}

/** Mirror of `evaluateEstateRules` — current audit × current rules. */
function computeViolations(state: ExposureState): ExposureViolationView[] {
  const out: ExposureViolationView[] = [];
  for (const r of state.rows) {
    if (r.publishedPorts.length === 0) continue;
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
  return out;
}

export const exposure: DomainResolvers = {
  seed: (store) => {
    const rows: ExposureRowView[] = [
      row({
        serviceId: 'svc-web',
        serviceName: 'web',
        stack: 'storefront',
        exposure: 'public-domain',
        domains: ['shop.northwind.dev'],
        details: ['shop.northwind.dev → :3000 (tls auto)'],
      }),
      row({
        serviceId: 'svc-api',
        serviceName: 'api',
        stack: 'storefront',
        exposure: 'public-domain',
        domains: ['api.northwind.dev'],
        details: ['api.northwind.dev → :8080 (tls auto)'],
      }),
      row({
        serviceId: 'svc-cdn',
        serviceName: 'cdn-edge',
        stack: 'storefront',
        exposure: 'public-port',
        publishedPorts: [{ target: 8081, published: 8081, protocol: 'tcp', mode: null }],
        details: [':8081 → 8081/tcp published'],
      }),
      row({ serviceId: 'svc-checkout', serviceName: 'checkout', stack: 'storefront' }),
      // The seeded violation: a managed postgres with a published port.
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
        enforce: false,
      },
    } satisfies ExposureState;
  },

  handlers: {
    'exposure.overview': (_i, s): ExposureOverview => {
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

    'exposure.rules': (_i, s): ExposureRulesView => ({ ...getState(s).rules }),

    'exposure.setRules': (i, s): ExposureRulesView => {
      const st = getState(s);
      const patch = i as SetExposureRulesInput;
      st.rules = {
        noPublicPortsOnManagedData:
          patch.noPublicPortsOnManagedData ?? st.rules.noPublicPortsOnManagedData,
        noPublicUdp: patch.noPublicUdp ?? st.rules.noPublicUdp,
        warnOnNewPublishedPorts:
          patch.warnOnNewPublishedPorts ?? st.rules.warnOnNewPublishedPorts,
        enforce: patch.enforce ?? st.rules.enforce,
      };
      return { ...st.rules };
    },

    'exposure.violations': (_i, s): ExposureViolationView[] => computeViolations(getState(s)),
  },
};
