import type { Inventory, InvContainer, InvEdge, InvService, ServiceDetail } from '@swarmy/core';
import { UNGROUPED } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo `inventory.get` — projects the demo store's services into the same
 * Project → Service → Container hierarchy the live controller returns, so the
 * Applications canvas renders identically offline. Services group by their stack
 * name; a couple of believable edges (one network, one depends) are synthesized;
 * containers are replica-count fakes. The output satisfies `Inventory` exactly.
 */

/** Services we present as scale-to-zero; cloudflared is shown asleep to demo idle. */
const SCALE_TO_ZERO = new Set(['cloudflared', 'cdn-edge']);

/**
 * swarmy's own platform plumbing lives in one managed, non-deletable stack
 * (`swarmy-system`) rather than floating as ungrouped services. Real services
 * get these two labels from their ServiceSpec (see packages/core inventory
 * constants); the demo layer hardcodes the exact same strings since ServiceDetail
 * has no raw labels bag to carry them through.
 */
const SYSTEM_STACK_NAME = 'swarmy-system';
const SYSTEM_STACK_LABEL = 'swarmy.system';
const SYSTEM_SERVICE_ROLES: Record<string, string> = {
  'swarmy-otel-collector': 'collector',
  'swarmy-clickhouse': 'store',
  'swarmy-ingress-caddy': 'ingress',
  'swarmy-garage': 'storage',
};

const STATUS_MAP: Record<string, InvService['status']> = {
  running: 'running',
  degraded: 'degraded',
  deploying: 'deploying',
  pending: 'deploying',
  stopped: 'stopped',
  failed: 'degraded',
  removing: 'stopped',
};

/** Believable links; filtered to services that still exist before they're returned. */
const SYNTHETIC_EDGES: InvEdge[] = [
  { from: 'svc-web', to: 'svc-api', kind: 'network', label: 'storefront_net' },
  { from: 'svc-api', to: 'svc-postgres', kind: 'depends', label: 'DATABASE_URL' },
  { from: 'svc-api', to: 'svc-redis', kind: 'depends', label: 'REDIS_URL' },
  { from: 'svc-worker', to: 'svc-nats', kind: 'network', label: 'data_net' },
  { from: 'svc-grafana', to: 'svc-prometheus', kind: 'depends', label: 'PROMETHEUS_URL' },
];

function makeContainers(sv: ServiceDetail): InvContainer[] {
  // `pending` = the task is still preparing (pulling the image): no container yet.
  if (sv.status === 'pending') return [];
  const out: InvContainer[] = [];
  for (let i = 1; i <= sv.replicas.running; i++)
    out.push({ id: `${sv.id}-ctr-${i}`, name: `${sv.name}.${i}`, image: sv.image, state: 'running' });
  for (let i = sv.replicas.running + 1; i <= sv.replicas.desired; i++)
    out.push({ id: `${sv.id}-ctr-${i}`, name: `${sv.name}.${i}`, image: sv.image, state: 'starting' });
  return out;
}

function toInvService(sv: ServiceDetail, stackName: string | null): InvService {
  const scaleToZero = SCALE_TO_ZERO.has(sv.name);
  const idle = sv.name === 'cloudflared'; // shown asleep so the idle affordance is visible
  const replicas = idle ? { desired: 0, running: 0 } : { ...sv.replicas };
  const role = SYSTEM_SERVICE_ROLES[sv.name];
  const labels: Record<string, string> = stackName ? { 'com.docker.stack.namespace': stackName } : {};
  if (role) {
    labels['swarmy.managed'] = 'true';
    labels['swarmy.role'] = role;
    labels[SYSTEM_STACK_LABEL] = 'true';
  }
  return {
    id: sv.id,
    name: sv.name,
    image: sv.image,
    stack: stackName ?? UNGROUPED,
    mode: 'replicated',
    replicas,
    status: idle ? 'idle' : (STATUS_MAP[sv.status] ?? 'running'),
    scaleToZero,
    labels,
    networks: sv.networks.map((name) => ({ name, aliases: [sv.name] })),
    env: Object.entries(sv.env).map(([k, v]) => `${k}=${v}`),
    ports: sv.ports.map((p) => ({ target: p.target, published: p.published, protocol: p.protocol })),
    containers: idle ? [] : makeContainers(sv),
  };
}

function buildDemoInventory(store: DemoStore): Inventory {
  const stackNameById = new Map(store.stacks.map((st) => [st.id, st.name]));
  const services = store.services.map((sv) =>
    toInvService(sv, sv.stackId ? (stackNameById.get(sv.stackId) ?? null) : null),
  );

  // Group into projects, keeping stack order; swarmy-system sorts after app
  // stacks (it's platform plumbing, not a user app) and the ungrouped catch-all
  // goes last of all.
  const grouped = new Map<string, string[]>();
  const order: string[] = [];
  for (const s of services) {
    if (!grouped.has(s.stack)) {
      grouped.set(s.stack, []);
      if (s.stack !== UNGROUPED && s.stack !== SYSTEM_STACK_NAME) order.push(s.stack);
    }
    grouped.get(s.stack)!.push(s.id);
  }
  if (grouped.has(SYSTEM_STACK_NAME)) order.push(SYSTEM_STACK_NAME);
  if (grouped.has(UNGROUPED)) order.push(UNGROUPED);
  const projects = order.map((name) => ({ name, serviceIds: grouped.get(name) ?? [] }));

  const ids = new Set(services.map((s) => s.id));
  const edges = SYNTHETIC_EDGES.filter((e) => ids.has(e.from) && ids.has(e.to));

  return { projects, services, edges };
}

/**
 * storefront's services run with a believable env (bindings, a plain URL, one
 * password left as a plain variable) so the Variables & secrets tab has
 * something to say. Seeded once into the store, so `services.get` agrees.
 */
const STOREFRONT_ENV: Record<string, Record<string, string>> = {
  'svc-web': { PUBLIC_URL: 'https://shop.northwind.dev', API_URL: 'http://api:8080', SHOP_CURRENCY: 'GBP' },
  'svc-api': {
    DATABASE_RO_URL: '${{ db.ro_url }}',
    REDIS_URL: '${{ cache.url }}',
    S3_BUCKET: '${{ storefront-media.bucket }}',
    SHOP_CURRENCY: 'GBP',
  },
  'svc-checkout': { DATABASE_RO_URL: '${{ db.ro_url }}', CHECKOUT_TIMEOUT_MS: '8000', PAYPAL_CLIENT_SECRET: 'pp_live_8f2a91c4d0e7b3' },
  'svc-cdn': { ORIGIN_URL: 'http://web:3000' },
};
const OTEL = (name: string): Record<string, string> => ({
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://swarmy-otel-collector:4317',
  OTEL_SERVICE_NAME: `storefront-${name}`,
});

const LOG_LINES = [
  'GET /health 200 2ms',
  'GET /api/cart 200 18ms',
  'POST /api/checkout 201 142ms',
  'worker: processed image-resize job 8812 in 311ms',
  'GET /api/products?page=2 200 24ms',
  'cache hit ratio 0.94 (last 60s)',
];

export const inventory: DomainResolvers = {
  // A believable live tail for any service page (services.logs).
  subscriptions: {
    'services.logs': (_i, _s, emit) => {
      let seq = 0;
      const push = (): void => {
        const i = seq % LOG_LINES.length;
        const stderr = seq % 11 === 7;
        emit({
          seq: seq++,
          stream: stderr ? 'stderr' : 'stdout',
          message: `${new Date().toISOString()} ${stderr ? 'WARN upstream slow: payments 1.2s' : LOG_LINES[i]}`,
        });
      };
      for (let k = 0; k < 12; k++) push();
      const t = setInterval(push, 1_500);
      return () => clearInterval(t);
    },
  },
  seed: (store) => {
    for (const sv of store.services) {
      const extra = STOREFRONT_ENV[sv.id];
      if (extra) sv.env = { ...sv.env, ...extra, ...OTEL(sv.name) };
    }
  },
  handlers: {
    'inventory.get': (_i, s) => buildDemoInventory(s),
  },
};
