import type { NodeSummary, ServiceSummary } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { AppItem } from '@/components/apps/use-apps';

/**
 * A server card's words, pure: its roles as short words, the busier of CPU
 * and memory for the ring, and the apps it runs as small rows. swarmy's own
 * parts (the system stack) are left off: the map shows your apps.
 */

/** "edge · controller" · "worker": what the server does, in a few words. */
export function roleWords(n: NodeSummary): string {
  const out: string[] = [];
  if (n.ingress) out.push('edge');
  if (n.role === 'manager') out.push('controller');
  if (n.database) out.push('databases');
  if (n.storage) out.push('files');
  if (n.builder) out.push('builds');
  return out.length ? out.join(' · ') : 'worker';
}

export interface Busy {
  /** 0..100, the higher of CPU and memory. */
  pct: number;
  which: 'CPU' | 'memory';
}

/** The ring's number from live stats; null while offline or before the first sample. */
export function busiest(n: NodeSummary): Busy | null {
  if (!n.live) return null;
  const { cpuPercent: cpu, memPercent: mem } = n.live;
  return cpu >= mem ? { pct: Math.round(cpu), which: 'CPU' } : { pct: Math.round(mem), which: 'memory' };
}

/** "8 vCPU · 32 GB" from the server's size, when known. */
export function sizeWords(n: NodeSummary): string {
  const cpu = n.resources.cpus ? `${n.resources.cpus} vCPU` : null;
  const mem = n.resources.memBytes ? `${Math.round(n.resources.memBytes / 1024 ** 3)} GB` : null;
  return [cpu, mem].filter(Boolean).join(' · ');
}

export interface ServerAppRow {
  app: string;
  /** "web ×2 api": the parts on this server, copies when more than one. */
  parts: string;
  tone: Tone;
  /** The app's own word when it isn't calm ("slow", "down"), else null. */
  word: string | null;
}

/** Up to three part names, then "+N". */
export function partsWords(services: Pick<ServiceSummary, 'name' | 'replicas'>[]): string {
  const names = services.map((s) => (s.replicas.running > 1 ? `${s.name} ×${s.replicas.running}` : s.name));
  return names.length > 3 ? `${names.slice(0, 3).join(' ')} +${names.length - 3}` : names.join(' ');
}

/**
 * The apps on one server, from `services.list({ nodeId })` folded onto apps
 * through the live inventory. Apps keep the inventory's order.
 */
export function serverApps(services: ServiceSummary[], apps: AppItem[], inventoryStackOf: Map<string, string>): ServerAppRow[] {
  const byStack = new Map<string, ServiceSummary[]>();
  for (const s of services) {
    const stack = inventoryStackOf.get(s.id) ?? s.stackId;
    if (stack) byStack.set(stack, [...(byStack.get(stack) ?? []), s]);
  }
  return apps.flatMap((a) => {
    const here = byStack.get(a.name);
    if (!here?.length) return [];
    const calm = a.words.tone === 'ok';
    return [{ app: a.name, parts: partsWords(here), tone: a.words.tone, word: calm ? null : a.words.word.toLowerCase() }];
  });
}

/** The reachability note: a server with no public address is reached over the private network only. */
export function reachNote(n: NodeSummary, onPrivateNetwork: boolean): string | null {
  if (n.publicIp) return null;
  return onPrivateNetwork ? 'private network only' : 'no public address';
}
