import type { NodeSummary } from '@swarmy/core';
import type { Tone } from '@/components/calm';

/**
 * "Where <svc> runs" (board AppScaling): one card per server with its memory
 * and the copies on it. Placement comes from `services.list({ nodeId })` per
 * server — which services have a copy there, not how many — so a count shows
 * only when it follows: one server holds them all, or every server holds
 * exactly one. PURE — unit-tested in strip-model.test.ts.
 */

export interface ServerCard {
  node: NodeSummary;
  /** Copies of the picked service here: a count when it can be told, null when some run here but the split is unknown. 0 = none. */
  copies: number | null;
  /** Other services with copies here (names as people use them). */
  others: string[];
  memUsed: number | null;
  memTotal: number | null;
  /** 0–100, from the live snapshot; null when the server isn't reporting. */
  memPct: number | null;
  tone: Tone;
}

/** Hot at 85% (the service settings bar's threshold). */
export const MEM_HOT_PCT = 85;

/** Copies per server, from which servers have one (see the header). */
export function copiesByServer(present: string[], running: number): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const known = present.length === 1 ? running : running === present.length ? 1 : null;
  for (const id of present) out.set(id, known);
  return out;
}

export function serverCards({
  nodes,
  servicesByNode,
  serviceId,
  running,
  label,
}: {
  nodes: NodeSummary[];
  servicesByNode: Map<string, Array<{ id: string; name: string }>>;
  serviceId: string;
  running: number;
  /** `storefront_api` → `api`. */
  label: (name: string) => string;
}): ServerCard[] {
  const shown = nodes.filter((n) => n.status !== 'offline');
  const present = shown.filter((n) => servicesByNode.get(n.id)?.some((s) => s.id === serviceId)).map((n) => n.id);
  const copies = copiesByServer(present, running);
  const cards = shown.map((node): ServerCard => {
    const total = node.resources.memBytes;
    const pct = node.live ? node.live.memPercent : null;
    const here = copies.has(node.id) ? copies.get(node.id)! : 0;
    return {
      node,
      copies: here,
      others: (servicesByNode.get(node.id) ?? []).filter((s) => s.id !== serviceId).map((s) => label(s.name)),
      memUsed: total !== null && pct !== null ? Math.round((total * pct) / 100) : null,
      memTotal: total,
      memPct: pct,
      tone: node.status === 'draining' ? 'idle' : pct !== null && pct >= MEM_HOT_PCT ? 'warn' : 'ok',
    };
  });
  // Servers with a copy first, then the rest, each in the order they came.
  return [...cards.filter((c) => c.copies !== 0), ...cards.filter((c) => c.copies === 0)];
}

const plural = (n: number): string => `${n} ${n === 1 ? 'copy' : 'copies'}`;

/** The mono note under a card's bar. */
export function serverNote(c: ServerCard, name: string): string {
  if (c.node.status === 'draining') return c.copies === 0 ? 'emptying · takes no new copies' : `emptying · ${name} moves off`;
  if (c.copies === null) return `${name} runs here`;
  if (c.copies > 0) return `${plural(c.copies)} of ${name}`;
  return `no ${name} here`;
}

/** "3 copies on 3 servers" / "4 copies, all on wkr-1" / "1 of 2 copies up, on wkr-2" — the strip's eyebrow. */
export function spreadWords(cards: ServerCard[], desired: number, running: number, name: string): string {
  const on = cards.filter((c) => c.copies !== 0);
  if (desired === 0) return `${name} has no copies running`;
  if (on.length === 0) return `${plural(desired)}, none placed yet`;
  const count = running < desired ? `${running} of ${plural(desired)} up` : plural(desired);
  if (on.length === 1) return `${count}, ${running < desired ? 'on' : 'all on'} ${on[0]!.node.name}`;
  return `${count} on ${on.length} servers`;
}

/** The plain hint beside the copies stepper. */
export function copiesHint(cards: ServerCard[] | undefined, desired: number, running: number, name: string): string {
  if (desired === 0) return `No copies: ${name} isn't running.`;
  if (desired === 1) return `One copy: while it restarts or its server stops, ${name} is down. Two keep it up through deploys.`;
  const on = cards?.filter((c) => c.copies !== 0) ?? [];
  if (on.length === 1) {
    const all =
      running < desired
        ? running === 1
          ? "The one copy that's up is"
          : "Every copy that's up is"
        : desired === 2
          ? 'Both copies are'
          : `All ${desired} copies are`;
    return `${all} on ${on[0]!.node.name}, so if it stops, ${name} stops.`;
  }
  if (on.length > 1) return `Spread over ${on.length} servers, so one can stop without an outage.`;
  return `${plural(desired)} share the load.`;
}

/** "4.6 / 8 GB". */
export function memWords(used: number | null, total: number | null): string {
  const gb = (b: number): string => String(Math.round((b / 1024 ** 3) * 10) / 10);
  if (total === null) return '—';
  return used === null ? `? / ${gb(total)} GB` : `${gb(used)} / ${gb(total)} GB`;
}
