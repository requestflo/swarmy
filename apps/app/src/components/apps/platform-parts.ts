import type { InvService, NodeSummary } from '@swarmy/core';
import type { Tone } from '@/components/calm';

/** One of swarmy's own parts as a small card on the Apps page. */
export interface PlatformPart {
  key: string;
  name: string;
  /** The mono tech line ("caddy · HTTPS · 3 edges"). */
  sub: string;
  tone: Tone;
}

export interface PlatformInput {
  /** The swarmy-system stack's services (live inventory). */
  system: InvService[];
  nodes?: NodeSummary[];
  /** The controller's running version (`platform.status`). */
  controllerVersion?: string | null;
  registry?: { enabled: boolean; host: string | null; online: boolean } | null;
}

const TONE: Record<InvService['status'], Tone> = {
  running: 'ok',
  degraded: 'warn',
  deploying: 'info',
  failing: 'bad',
  idle: 'idle',
  stopped: 'idle',
};

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * swarmy's parts from what is really running: the controller, then each
 * platform service that exists. A part with no data is left out, never shown
 * as a guess.
 */
export function platformParts(p: PlatformInput): PlatformPart[] {
  const svc = (name: string): InvService | undefined => p.system.find((s) => s.name === name);
  const nodes = p.nodes ?? [];
  const out: PlatformPart[] = [];
  if (p.controllerVersion) {
    out.push({ key: 'swarmy', name: 'swarmy', sub: `dashboard + API · v${p.controllerVersion.replace(/^v/, '')}`, tone: 'ok' });
  }
  const caddy = svc('swarmy-ingress-caddy');
  if (caddy) {
    const edges = nodes.filter((n) => n.ingress).length || caddy.replicas.running;
    out.push({ key: 'edge', name: 'Front door', sub: `caddy · HTTPS · ${count(edges, 'edge')}`, tone: TONE[caddy.status] });
  }
  const dns = svc('swarmy-dns');
  if (dns) out.push({ key: 'dns', name: 'Geo DNS', sub: `swarmy-dns · ${count(dns.replicas.running, 'edge')}`, tone: TONE[dns.status] });
  const garage = svc('swarmy-garage');
  if (garage) {
    const servers = nodes.filter((n) => n.storage).length || garage.replicas.running;
    out.push({ key: 'storage', name: 'Object storage', sub: `garage · ${count(servers, 'server')}`, tone: TONE[garage.status] });
  }
  const registry = svc('swarmy-registry');
  if (p.registry?.enabled || registry) {
    const tone: Tone = registry ? TONE[registry.status] : p.registry?.online ? 'ok' : 'bad';
    out.push({ key: 'registry', name: 'Registry', sub: p.registry?.host ?? 'registry:2 · in the cluster', tone });
  }
  const otel = svc('swarmy-otel-collector');
  if (otel) {
    const store = svc('swarmy-clickhouse');
    out.push({ key: 'telemetry', name: 'Telemetry', sub: `otel collector${store ? ' · clickhouse' : ''}`, tone: TONE[otel.status] });
  }
  return out;
}

/** "4 of 4 running" for the chip beside the Platform title. */
export function platformRunning(parts: PlatformPart[]): { ok: number; total: number } {
  return { ok: parts.filter((x) => x.tone === 'ok' || x.tone === 'idle').length, total: parts.length };
}
