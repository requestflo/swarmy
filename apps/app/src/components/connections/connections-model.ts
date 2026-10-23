import { isSystemStack, linkAlias } from '@swarmy/core';
import type { EndpointName, LinkAuditEntry, ResourceEndpoint, ResourceKind, ServiceEndpoints, StackEndpoints } from './types';

/** `host:port`, or the bare host when the service has no single port. */
export function hostPort(host: string, port?: number): string {
  return port ? `${host}:${port}` : host;
}

/** `storefront_web` → `web` (attached lists carry swarm service names). */
export function shortOf(stack: string, service: string): string {
  return service.startsWith(`${stack}_`) ? service.slice(stack.length + 1) : service;
}

/** "a", "a and b", "a, b and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Apps that can be connected: user apps that run something (platform stacks
 * never link), in the Apps list's order so the first is the default pick.
 */
export function connectableApps(stacks: ReadonlyArray<{ name: string; serviceCount: number }>): string[] {
  return [...new Set(stacks.filter((s) => s.serviceCount > 0 && !isSystemStack(s.name)).map((s) => s.name))];
}

/** The name app code types inside the app: the short compose name when swarm aliases it. */
export function typedName(s: ServiceEndpoints): EndpointName | undefined {
  return s.names.find((n) => n.scope === 'app' && n.host === s.short) ?? s.names[0];
}

/** What a connected app types to reach each of `e`'s services: `api.storefront:8080`. */
export function peerAddresses(e: StackEndpoints): string[] {
  return e.services.map((s) => hostPort(linkAlias(e.stack, s.short), s.ports.length === 1 ? s.ports[0] : undefined));
}

/** One managed resource with its members folded together (primary first). */
export interface ManagedGroup {
  kind: ResourceKind;
  name: string;
  /** The address to type: the writer / instance. */
  main: ResourceEndpoint;
  /** Standby copies and sentinels (Controls). */
  others: ResourceEndpoint[];
  attached: string[];
}

const KIND_ORDER: ResourceKind[] = ['postgres', 'cache', 'search', 'vector', 'object-storage'];

export function groupResources(rs: readonly ResourceEndpoint[]): ManagedGroup[] {
  const byKey = new Map<string, ResourceEndpoint[]>();
  for (const r of rs) byKey.set(`${r.kind}:${r.name}`, [...(byKey.get(`${r.kind}:${r.name}`) ?? []), r]);
  const out: ManagedGroup[] = [];
  for (const members of byKey.values()) {
    const main = members.find((m) => m.role === 'primary') ?? members.find((m) => !m.role) ?? members[0]!;
    out.push({
      kind: main.kind,
      name: main.name,
      main,
      others: members.filter((m) => m !== main),
      attached: [...new Set(members.flatMap((m) => m.attached))].sort(),
    });
  }
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
}

export const KIND_WORD: Record<ResourceKind, string> = {
  postgres: 'Postgres',
  cache: 'cache',
  search: 'search',
  vector: 'vector store',
  'object-storage': 'bucket',
};

/** "Postgres checkout, cache main and bucket app-uploads". */
export function dataWords(groups: readonly ManagedGroup[]): string {
  return listWords(groups.map((g) => `${KIND_WORD[g.kind]} ${g.name}`));
}

/** "Postgres checkout stays private to storefront; Postgres main to data." */
export function privateWords(app: string, mine: readonly ManagedGroup[], peer: string, theirs: readonly ManagedGroup[]): string {
  const stay = (n: number): string => (n === 1 ? 'stays' : 'stay');
  if (!mine.length && !theirs.length) return 'Neither app has a managed database, cache or bucket.';
  const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
  if (!mine.length) return cap(`${dataWords(theirs)} ${stay(theirs.length)} private to ${peer}.`);
  const first = cap(`${dataWords(mine)} ${stay(mine.length)} private to ${app}`);
  return theirs.length ? `${first}; ${dataWords(theirs)} to ${peer}.` : `${first}.`;
}

/**
 * The env var the wiring already set: Postgres injects DATABASE_URL (the
 * `db.inject` default), a bucket S3_ENDPOINT (+ the other S3_* keys);
 * cache/search/vector name theirs per attachment (`<kind>.list`).
 */
export function envVarsFor(g: ManagedGroup, attachmentVars: Record<string, string[]>): string[] {
  if (g.kind === 'postgres') return ['DATABASE_URL'];
  if (g.kind === 'object-storage') return ['S3_ENDPOINT'];
  return attachmentVars[`${g.kind}:${g.name}`] ?? [];
}

/** A failed connect/disconnect in plain words; a policy deny names what's needed. */
export function linkErrorWords(e: unknown, app: string, peer: string): string {
  const err = e as { message?: string; data?: { swarmyCode?: string } } | null;
  if (err?.data?.swarmyCode === 'POLICY_DENIED') return `You need deploy permission on both ${app} and ${peer}.`;
  return err?.message ?? String(e);
}

/** Local clock for today, else a short date and time. */
export function clock(ts: string, now = new Date()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/** The newest `stack.link.*` audit row naming `app`, as one line: action · who · when · pair. */
export function linkAuditLine(entries: readonly LinkAuditEntry[], app: string, fmt: (ts: string) => string = clock): string | null {
  const row = entries.find((e) => e.action.startsWith('stack.link.') && (e.targetId ?? '').split('<->').includes(app));
  if (!row) return null;
  const [a, b] = (row.targetId ?? '').split('<->');
  return `${row.action} · ${row.actorLabel} · ${fmt(row.ts)} · ${a} ↔ ${b}`;
}
