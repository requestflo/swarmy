import { describe, expect, test } from 'bun:test';
import type { InvService, NodeSummary } from '@swarmy/core';
import { platformParts, platformRunning } from './platform-parts';

const svc = (name: string, status: InvService['status'] = 'running', running = 1): InvService =>
  ({ id: name, name, status, replicas: { desired: running, running } }) as InvService;
const node = (id: string, roles: Partial<NodeSummary>): NodeSummary => ({ id, name: id, ...roles }) as NodeSummary;

describe('platformParts', () => {
  test('nothing known → no cards', () => {
    expect(platformParts({ system: [] })).toEqual([]);
  });
  test('each part from what really runs, in board order', () => {
    const parts = platformParts({
      system: [svc('swarmy-otel-collector'), svc('swarmy-clickhouse'), svc('swarmy-ingress-caddy', 'running', 3), svc('swarmy-garage'), svc('swarmy-dns', 'running', 2)],
      nodes: [node('a', { ingress: true, storage: true }), node('b', { ingress: true }), node('c', { storage: true })],
      controllerVersion: 'v1.2.4',
      registry: { enabled: true, host: 'registry.northwind.dev', online: true },
    });
    expect(parts.map((p) => [p.name, p.sub])).toEqual([
      ['swarmy', 'dashboard + API · v1.2.4'],
      ['Front door', 'caddy · HTTPS · 2 edges'],
      ['Geo DNS', 'swarmy-dns · 2 edges'],
      ['Object storage', 'garage · 2 servers'],
      ['Registry', 'registry.northwind.dev'],
      ['Telemetry', 'otel collector · clickhouse'],
    ]);
    expect(platformRunning(parts)).toEqual({ ok: 6, total: 6 });
  });
  test('a struggling part carries its tone; an offline registry is bad', () => {
    const parts = platformParts({ system: [svc('swarmy-ingress-caddy', 'degraded')], registry: { enabled: true, host: null, online: false } });
    expect(parts.map((p) => p.tone)).toEqual(['warn', 'bad']);
    expect(platformRunning(parts)).toEqual({ ok: 0, total: 2 });
  });
  test('a disabled registry is left out', () => {
    expect(platformParts({ system: [], registry: { enabled: false, host: null, online: false } })).toEqual([]);
  });
});
