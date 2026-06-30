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
  return {
    id: sv.id,
    name: sv.name,
    image: sv.image,
    stack: stackName ?? UNGROUPED,
    mode: 'replicated',
    replicas,
    status: idle ? 'idle' : (STATUS_MAP[sv.status] ?? 'running'),
    scaleToZero,
    labels: stackName ? { 'com.docker.stack.namespace': stackName } : {},
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

  // Group into projects, keeping stack order; the ungrouped catch-all goes last.
  const grouped = new Map<string, string[]>();
  const order: string[] = [];
  for (const s of services) {
    if (!grouped.has(s.stack)) {
      grouped.set(s.stack, []);
      if (s.stack !== UNGROUPED) order.push(s.stack);
    }
    grouped.get(s.stack)!.push(s.id);
  }
  if (grouped.has(UNGROUPED)) order.push(UNGROUPED);
  const projects = order.map((name) => ({ name, serviceIds: grouped.get(name) ?? [] }));

  const ids = new Set(services.map((s) => s.id));
  const edges = SYNTHETIC_EDGES.filter((e) => ids.has(e.from) && ids.has(e.to));

  return { projects, services, edges };
}

export const inventory: DomainResolvers = {
  handlers: {
    'inventory.get': (_i, s) => buildDemoInventory(s),
    // Contextual deploy: add a single app into an existing stack (Docker namespace).
    'stacks.addServiceToStack': (i, s) => {
      const b = i as {
        stack: string;
        name: string;
        image: string;
        ports?: { target: number; published?: number; protocol?: 'tcp' | 'udp' }[];
        replicas?: number;
      };
      const stack = s.stacks.find((st) => st.name === b.stack);
      const id = `svc-${b.name}-${Math.random().toString(36).slice(2, 6)}`;
      s.services.push({
        id,
        name: b.name,
        image: b.image,
        status: 'deploying',
        replicas: { desired: b.replicas ?? 1, running: 0 },
        ingressEnabled: (b.ports?.length ?? 0) > 0,
        nodeId: null,
        stackId: stack?.id ?? null,
        updatedAt: new Date().toISOString(),
        env: {},
        ports: (b.ports ?? []).map((p) => ({
          target: p.target,
          published: p.published,
          protocol: p.protocol ?? 'tcp',
          mode: 'ingress' as const,
        })),
      } as (typeof s.services)[number]);
      if (stack) stack.serviceCount += 1;
      return { id };
    },
  },
};
