import type { NodeSummary, ServiceDetail } from '@swarmy/core';
import { toYaml, withHeader, curl, type CodeTab } from '@/components/calm';
import { shortName } from '../use-stack-services';
import type { PlacedService } from './use-app-placement';

/** A server's region (`swarmy.region`), if it has one. */
export function regionOf(n: NodeSummary | undefined): string | undefined {
  return n?.region ?? undefined;
}

const PIN = /^node\.(id|hostname)\s*==\s*(.+)$/;

/** The server a service is pinned to, if any (by id or hostname constraint). */
export function pinnedServer(d: ServiceDetail | null | undefined, nodes: NodeSummary[]): NodeSummary | undefined {
  if (!d) return undefined;
  if (d.nodeId) {
    const byId = nodes.find((n) => n.id === d.nodeId);
    if (byId) return byId;
  }
  for (const c of d.constraints) {
    const m = PIN.exec(c.trim());
    if (m) {
      const v = m[2]!.trim();
      const hit = nodes.find((n) => n.id === v || n.hostname === v || n.name === v);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** "Runs on wkr-1 (eu-west)" · "Anywhere there's room" · "Only on servers labelled gpu". */
export function whereWords(d: ServiceDetail | null | undefined, nodes: NodeSummary[]): string {
  const pin = pinnedServer(d, nodes);
  if (pin) return `Stays on ${pin.name}${regionOf(pin) ? ` in ${regionOf(pin)}` : ''}`;
  const other = d?.constraints.filter((c) => !PIN.test(c.trim())) ?? [];
  if (other.length) return `Only on servers that match ${other.length === 1 ? 'one rule' : `${other.length} rules`}`;
  return "Anywhere there's room";
}

/** The deploy block (live spec) and the REST call behind the stepper. */
export function scalingCode(stack: string, rows: PlacedService[]): CodeTab[] {
  const services: Record<string, { deploy: { replicas: number; placement?: { constraints: string[] } } }> = {};
  for (const r of rows) {
    const constraints = r.detail?.constraints ?? [];
    services[shortName(stack, r.inv.name)] = {
      deploy: { replicas: r.inv.replicas.desired, ...(constraints.length ? { placement: { constraints } } : {}) },
    };
  }
  const first = rows[0];
  return [
    { label: 'compose', code: withHeader(`${stack} — the deploy block swarmy is running`, toYaml({ services })) },
    ...(first
      ? [{ label: 'REST', code: curl('POST', `/services/${first.inv.id}/scale`, { replicas: first.inv.replicas.desired }) }]
      : []),
  ];
}
