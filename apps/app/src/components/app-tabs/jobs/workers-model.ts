import type { InvService, QueueView } from '@swarmy/core';

/**
 * Workers (board AppJobs): the parts nobody reaches from outside — no
 * published port and no front-door route — plus every service a queue
 * names as its worker. Managed data members and canaries aren't workers.
 * PURE — unit-tested in workers-model.test.ts.
 */

export interface WorkerRow {
  /** Docker service name. */
  service: string;
  part: string;
  inv: InvService | null;
  queues: QueueView[];
  copies: { desired: number; running: number };
}

const DATA_LABEL = /^swarmy\.(db|cache|search|vector)\./;
const ROUTES_LABEL = 'swarmy.ingress.routes';

export function isWorker(s: InvService): boolean {
  if (s.ports.some((p) => p.published)) return false;
  if (s.name.endsWith('--canary') || s.regionParent) return false;
  const keys = Object.keys(s.labels);
  if (keys.some((k) => DATA_LABEL.test(k))) return false;
  const routes = s.labels[ROUTES_LABEL];
  return !routes || routes === '[]';
}

export function workerRows(stack: string, services: InvService[], queues: QueueView[]): WorkerRow[] {
  const short = (n: string): string => (n.startsWith(`${stack}_`) ? n.slice(stack.length + 1) : n);
  const byName = new Map<string, WorkerRow>();
  for (const s of services.filter(isWorker)) {
    byName.set(s.name, { service: s.name, part: short(s.name), inv: s, queues: [], copies: s.replicas });
  }
  for (const q of queues) {
    const inv = services.find((s) => s.name === q.workerService || s.name === short(q.workerService)) ?? null;
    const key = inv?.name ?? q.workerService;
    const row = byName.get(key) ?? { service: q.workerService, part: short(q.workerService), inv, queues: [], copies: inv?.replicas ?? q.workers };
    row.queues.push(q);
    byName.set(key, row);
  }
  return [...byName.values()].sort((a, b) => b.queues.length - a.queues.length || a.part.localeCompare(b.part));
}
