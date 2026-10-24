import {
  healthcheckExecCmd,
  type HealthCopyView,
  type HealthTestView,
  type ServiceDetail,
  type ServiceHealthProbesView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { knobs } from './service-settings';

/**
 * The health check's live side in the demo (board AppRollout): Docker's
 * last 5 probes per running copy, laid on the check's real interval and
 * stable between refetches, and "Test now" answering like a copy would.
 * A degraded service has one copy failing, so the unhappy path shows too.
 */

const KEPT = 5;

/** Stable 0..1 from a string (FNV-1a), so a probe looks the same on every refetch. */
function rand(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

function serviceOf(store: DemoStore, input: unknown): ServiceDetail {
  const id = (input as { id: string }).id;
  const sv = store.services.find((s) => s.id === id);
  if (!sv) throw new Error(`service "${id}" not found`);
  return sv;
}

function nodeFor(store: DemoStore, sv: ServiceDetail, i: number): { id: string; name: string } {
  const pinned = sv.nodeId ? store.nodes.find((n) => n.id === sv.nodeId) : undefined;
  const pool = store.nodes.filter((n) => n.status === 'online');
  const n = pinned ?? pool[i % Math.max(pool.length, 1)] ?? store.nodes[0];
  return { id: n?.id ?? 'n-demo', name: n?.name ?? 'demo-1' };
}

const containerOf = (sv: ServiceDetail, i: number): string => `${sv.id.replace(/[^a-z0-9]/g, '')}${i + 1}`.padEnd(12, '0') + '4f2a9c1b';

function copyOf(store: DemoStore, sv: ServiceDetail, i: number, everyMs: number, now: number): HealthCopyView {
  const failing = sv.status === 'degraded' && i === sv.replicas.running - 1;
  const last = Math.floor((now - i * 1_700) / everyMs) * everyMs + i * 1_700;
  const port = sv.ports[0]?.target ?? 80;
  const probes = Array.from({ length: KEPT }, (_, k) => {
    const at = last - (KEPT - 1 - k) * everyMs;
    const r = rand(`${sv.id}:${i}:${at}`);
    if (failing && k >= 2) return { at, durationMs: 1.2 + r, exitCode: 1, output: `curl: (7) Failed to connect to localhost port ${port}: Connection refused` };
    return { at, durationMs: r < 0.05 ? Math.round(150 + r * 2_000) : Math.round((2.8 + r * 2.4) * 10) / 10, exitCode: 0 };
  });
  const node = nodeFor(store, sv, i);
  return { nodeId: node.id, node: node.name, containerId: containerOf(sv, i), status: failing ? 'unhealthy' : 'healthy', failingStreak: failing ? 3 : 0, probes };
}

function probesView(store: DemoStore, sv: ServiceDetail): ServiceHealthProbesView {
  const hc = knobs(store, sv).health;
  if (!hc || hc.disable || !hc.test?.length) return { copies: [], test: null };
  const everyMs = hc.intervalNs ? hc.intervalNs / 1e6 : 30_000;
  const now = Date.now();
  return { copies: Array.from({ length: sv.replicas.running }, (_, i) => copyOf(store, sv, i, everyMs, now)), test: hc.test };
}

function testNow(store: DemoStore, sv: ServiceDetail): HealthTestView {
  const hc = knobs(store, sv).health;
  if (hc?.disable) throw new Error(`${sv.name}’s health check is switched off, so there is nothing to test`);
  const cmd = healthcheckExecCmd(hc?.test);
  if (!cmd) throw new Error(`${sv.name} has no health check to test — add one first`);
  if (sv.replicas.running === 0) throw new Error(`${sv.name} has no running copy to test its health check in — start it first`);
  const failing = sv.status === 'degraded';
  const node = nodeFor(store, sv, 0);
  const at = Date.now();
  return failing
    ? { ok: false, exitCode: 7, timedOut: false, durationMs: 1.6, output: `curl: (7) Failed to connect to localhost port ${sv.ports[0]?.target ?? 80}: Connection refused`, at, node: node.name, containerId: containerOf(sv, 0), cmd }
    : { ok: true, exitCode: 0, timedOut: false, durationMs: Math.round((2.8 + Math.random() * 2.4) * 10) / 10, output: '', at, node: node.name, containerId: containerOf(sv, 0), cmd };
}

export const serviceHealth: DomainResolvers = {
  handlers: {
    'services.healthProbes': (i, store) => probesView(store, serviceOf(store, i)),
    'services.testHealthcheck': (i, store) => testNow(store, serviceOf(store, i)),
  },
};
