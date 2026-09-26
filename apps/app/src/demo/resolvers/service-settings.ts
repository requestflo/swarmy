import type { ServiceDetail, ServiceUsageView, UpdateServiceInput } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * The service settings panel's demo world: each service's spec knobs the
 * inventory doesn't carry (command, resources, restart policy, rolling
 * update, health check, labels), returned as a realistic raw
 * `docker service inspect` and changed in place by `services.update`.
 */
interface Knobs {
  command?: string[];
  args?: string[];
  limits?: { cpus?: number; mem?: number };
  reservations?: { cpus?: number; mem?: number };
  restart?: { condition: 'on-failure' | 'any' | 'none'; maxAttempts?: number; delaySec?: number };
  update?: { parallelism: number; order: 'start-first' | 'stop-first'; failureAction?: string };
  health?: { test: string[]; intervalSec: number; startSec: number; retries: number };
  labels: Record<string, string>;
}

const MB = 1024 ** 2;
const KEY = 'serviceKnobs';

const HTTP = (port: number): Knobs['health'] => ({
  test: ['CMD', 'wget', '-qO-', `http://localhost:${port}/health`],
  intervalSec: 10,
  startSec: 15,
  retries: 3,
});

/** Per-service knobs; anything not listed gets Docker's defaults (no limits, restart any). */
const SEED: Record<string, Omit<Knobs, 'labels'> & { labels?: Record<string, string> }> = {
  'svc-web': {
    command: ['node', 'server.js'],
    limits: { cpus: 0.5, mem: 512 * MB },
    reservations: { cpus: 0.25, mem: 256 * MB },
    restart: { condition: 'on-failure', maxAttempts: 3, delaySec: 5 },
    update: { parallelism: 1, order: 'start-first', failureAction: 'rollback' },
    health: HTTP(3000),
  },
  'svc-api': {
    command: ['node', 'dist/server.js'],
    args: ['--port', '8080'],
    limits: { cpus: 0.5, mem: 512 * MB },
    reservations: { cpus: 0.25, mem: 256 * MB },
    restart: { condition: 'on-failure', maxAttempts: 3, delaySec: 5 },
    update: { parallelism: 1, order: 'start-first', failureAction: 'rollback' },
    health: HTTP(8080),
  },
  'svc-checkout': {
    command: ['node', 'dist/checkout.js'],
    limits: { cpus: 0.5, mem: 256 * MB },
    restart: { condition: 'on-failure', maxAttempts: 5, delaySec: 10 },
    update: { parallelism: 1, order: 'stop-first' },
    health: HTTP(8090),
  },
  'svc-worker': {
    command: ['node', 'dist/worker.js'],
    limits: { cpus: 1, mem: 768 * MB },
    restart: { condition: 'any' },
    update: { parallelism: 2, order: 'start-first' },
  },
  'svc-postgres': {
    limits: { cpus: 2, mem: 1024 * MB },
    reservations: { cpus: 1, mem: 768 * MB },
    restart: { condition: 'any', delaySec: 5 },
    update: { parallelism: 1, order: 'stop-first' },
  },
};

function knobsFor(store: DemoStore): Record<string, Knobs> {
  return (store.extra[KEY] ??= {}) as Record<string, Knobs>;
}

function knobs(store: DemoStore, sv: ServiceDetail): Knobs {
  const all = knobsFor(store);
  const stack = store.stacks.find((st) => st.id === sv.stackId)?.name;
  return (all[sv.id] ??= {
    ...(SEED[sv.id] ?? { restart: { condition: 'any' } }),
    labels: {
      ...(stack ? { 'com.docker.stack.namespace': stack, 'swarmy.managed': 'true', 'swarmy.env': 'production' } : {}),
      ...(sv.stackId === 's-store' ? { 'swarmy.otel': 'on' } : {}),
      ...(SEED[sv.id]?.labels ?? {}),
    },
  });
}

const ns = (sec: number | undefined): number | undefined => (sec === undefined ? undefined : sec * 1e9);
const side = (s: Knobs['limits']) => (s ? { NanoCPUs: s.cpus !== undefined ? s.cpus * 1e9 : undefined, MemoryBytes: s.mem } : undefined);

/** A raw `docker service inspect` for a demo service (the shape specFromInspect reads). */
function inspectOf(store: DemoStore, sv: ServiceDetail): Record<string, unknown> {
  const k = knobs(store, sv);
  return {
    ID: sv.swarmServiceId ?? sv.id,
    Version: { Index: 42 },
    Spec: {
      Name: sv.name,
      Labels: k.labels,
      Mode: { Replicated: { Replicas: sv.replicas.desired } },
      TaskTemplate: {
        ContainerSpec: {
          Image: sv.image,
          Command: k.command,
          Args: k.args,
          Env: Object.entries(sv.env).map(([key, v]) => `${key}=${v}`),
          Healthcheck: k.health
            ? { Test: k.health.test, Interval: ns(k.health.intervalSec), StartPeriod: ns(k.health.startSec), Retries: k.health.retries }
            : undefined,
        },
        Resources: { Limits: side(k.limits), Reservations: side(k.reservations) },
        RestartPolicy: k.restart
          ? { Condition: k.restart.condition, MaxAttempts: k.restart.maxAttempts, Delay: ns(k.restart.delaySec) }
          : undefined,
      },
      UpdateConfig: k.update
        ? { Parallelism: k.update.parallelism, Order: k.update.order, FailureAction: k.update.failureAction }
        : undefined,
      EndpointSpec: {
        Ports: sv.ports.map((p) => ({ TargetPort: p.target, PublishedPort: p.published, Protocol: p.protocol, PublishMode: p.mode })),
      },
    },
  };
}

/** Apply a `services.update` input's settings knobs to the demo world. */
export function applyDemoSettings(store: DemoStore, sv: ServiceDetail, b: UpdateServiceInput): void {
  const k = knobs(store, sv);
  if (b.command) {
    k.command = b.command.length ? b.command : undefined;
    k.args = undefined;
  }
  if (b.resources) {
    for (const s of ['limits', 'reservations'] as const) {
      const v = b.resources[s];
      if (v === undefined) continue;
      k[s] = v ? { cpus: v.cpus, mem: v.memoryBytes } : undefined;
    }
  }
  if (b.restartPolicy) {
    const { condition, maxAttempts, delaySeconds } = b.restartPolicy;
    k.restart = condition === 'none' ? { condition } : { ...k.restart, condition, ...(maxAttempts !== undefined ? { maxAttempts } : {}), ...(delaySeconds !== undefined ? { delaySec: delaySeconds } : {}) };
  }
  if (b.updateOrder) k.update = { ...(k.update ?? { parallelism: 1 }), order: b.updateOrder };
  for (const key of b.removeLabels ?? []) delete k.labels[key];
  Object.assign(k.labels, b.setLabels ?? {});
}

/** A steady-ish per-copy sample under the memory limit. */
function usageOf(store: DemoStore, sv: ServiceDetail): ServiceUsageView | null {
  const running = sv.replicas.running;
  if (running === 0) return null;
  const k = knobs(store, sv);
  const wobble = 0.9 + Math.random() * 0.2;
  const memPeak = Math.round(((k.limits?.mem ?? 1024 * MB) * 0.6 + 12 * MB) * wobble);
  const cpuPeak = (k.limits?.cpus ?? 1) * 0.3 * wobble;
  return {
    sampled: running,
    cpuCores: { avg: cpuPeak * 0.8, peak: cpuPeak },
    memBytes: { avg: Math.round(memPeak * 0.85), peak: memPeak },
    ts: Date.now(),
  };
}

export const serviceSettings: DomainResolvers = {
  handlers: {
    'services.inspect': (i, store) => {
      const sv = store.services.find((s) => s.id === (i as { id: string }).id);
      return sv ? inspectOf(store, sv) : {};
    },
    'services.usage': (i, store) => {
      const sv = store.services.find((s) => s.id === (i as { id: string }).id);
      if (!sv) throw new Error(`service "${(i as { id: string }).id}" not found`);
      return usageOf(store, sv);
    },
  },
};
