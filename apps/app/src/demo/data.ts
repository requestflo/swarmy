import type { NodeDetail, ServiceDetail } from '@swarmy/core';

/**
 * The demo cluster — a small, believable production swarm so every surface looks
 * alive: 5 nodes (a manager pair + workers, one draining), 12 services across 3
 * stacks with varied health, ingress, and placement. Kept intentionally coherent
 * (services sit on nodes that exist; ingress points at real services).
 */

const now = Date.now();
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function node(
  id: string,
  name: string,
  role: 'manager' | 'worker',
  status: NodeDetail['status'],
  cpus: number,
  memGiB: number,
  cpuPct: number,
  memPct: number,
  ip: string,
): NodeDetail {
  return {
    id,
    name,
    hostname: `${name}.swarm.internal`,
    role,
    status,
    engineVersion: '27.3.1',
    os: 'Ubuntu 24.04',
    arch: 'x86_64',
    resources: { cpus, memBytes: memGiB * 1024 ** 3 },
    agentVersion: '0.1.0',
    lastSeenAt: status === 'offline' ? iso(6 * MIN) : iso(3_000),
    live: status === 'online' || status === 'draining' ? { cpuPercent: cpuPct, memPercent: memPct } : null,
    ipAddress: ip,
    swarmNodeId: `swarm-${id}`,
    labels: role === 'manager' ? { role: 'manager', zone: 'eu-west' } : { zone: 'eu-west' },
    joinedAt: iso(30 * DAY),
  };
}

export const DEMO_NODES: NodeDetail[] = [
  node('n-mgr-1', 'mgr-1', 'manager', 'online', 8, 32, 34, 51, '10.0.1.11'),
  node('n-mgr-2', 'mgr-2', 'manager', 'online', 8, 32, 28, 47, '10.0.1.12'),
  node('n-wkr-1', 'wkr-1', 'worker', 'online', 16, 64, 62, 70, '10.0.1.21'),
  node('n-wkr-2', 'wkr-2', 'worker', 'online', 16, 64, 41, 58, '10.0.1.22'),
  node('n-wkr-3', 'wkr-3', 'worker', 'draining', 16, 64, 12, 22, '10.0.1.23'),
];

export const DEMO_STACKS = [
  { id: 's-store', name: 'storefront', serviceCount: 4, status: 'running', updatedAt: iso(2 * HOUR) },
  { id: 's-data', name: 'data', serviceCount: 4, status: 'running', updatedAt: iso(5 * HOUR) },
  { id: 's-platform', name: 'platform', serviceCount: 3, status: 'degraded', updatedAt: iso(20 * MIN) },
];

function svc(
  id: string,
  name: string,
  image: string,
  status: ServiceDetail['status'],
  desired: number,
  running: number,
  nodeId: string | null,
  stackId: string | null,
  ingress: boolean,
  ports: ServiceDetail['ports'] = [],
): ServiceDetail {
  return {
    id,
    name,
    image,
    status,
    replicas: { desired, running },
    ingressEnabled: ingress,
    nodeId,
    stackId,
    updatedAt: iso(15 * MIN),
    env: { NODE_ENV: 'production', LOG_LEVEL: 'info' },
    ports,
    volumes: [],
    networks: stackId ? [`${stackId}_net`] : ['swarmy_public'],
    constraints: nodeId ? [`node.id == swarm-${nodeId}`] : [],
    swarmServiceId: `svc-${id}`,
    createdAt: iso(30 * DAY),
  };
}

const web = (target: number) => [{ target, published: target, protocol: 'tcp', mode: 'ingress' }];

export const DEMO_SERVICES: ServiceDetail[] = [
  svc('svc-web', 'web', 'ghcr.io/northwind/web:1.8.2', 'running', 3, 3, null, 's-store', true, web(3000)),
  svc('svc-api', 'api', 'ghcr.io/northwind/api:2.4.0', 'running', 4, 4, 'n-wkr-1', 's-store', true, web(8080)),
  svc('svc-checkout', 'checkout', 'ghcr.io/northwind/checkout:1.1.0', 'degraded', 2, 1, 'n-wkr-2', 's-store', false),
  svc('svc-cdn', 'cdn-edge', 'ghcr.io/northwind/cdn:0.9.4', 'running', 2, 2, null, 's-store', true, web(8081)),
  svc('svc-postgres', 'postgres', 'postgres:16-alpine', 'running', 1, 1, 'n-wkr-1', 's-data', false),
  svc('svc-redis', 'redis', 'redis:7-alpine', 'running', 1, 1, 'n-wkr-2', 's-data', false),
  svc('svc-nats', 'nats', 'nats:2.10-alpine', 'running', 3, 3, null, 's-data', false),
  svc('svc-worker', 'worker', 'ghcr.io/northwind/worker:2.4.0', 'running', 5, 5, null, 's-data', false),
  svc('svc-grafana', 'grafana', 'grafana/grafana:11.3.0', 'running', 1, 1, 'n-mgr-2', 's-platform', true, web(3001)),
  svc('svc-prometheus', 'prometheus', 'prom/prometheus:v3.0.0', 'running', 1, 1, 'n-mgr-2', 's-platform', false),
  svc('svc-loki', 'loki', 'grafana/loki:3.2.0', 'deploying', 2, 1, null, 's-platform', false),
  svc('svc-tunnel', 'cloudflared', 'cloudflare/cloudflared:2024.10.0', 'running', 2, 2, null, null, false),
];

export const DEMO_ORG = { id: 'org-demo', name: 'Northwind', slug: 'northwind', role: 'owner' as const };
export const DEMO_USER = { id: 'user-demo', name: 'Demo Pilot', email: 'pilot@swarmy.dev' };
