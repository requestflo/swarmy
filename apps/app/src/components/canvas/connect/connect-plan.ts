import { KIND_WORD, hostPort, typedName } from '@/components/connections/connections-model';
import type { StackEndpoints } from '@/components/connections/types';
import type { DataNodeSpec, EnvLine } from '../data-nodes';

/** What connecting a part to a store does, in words, before anything changes. */
export interface ConnectPlan {
  /** "web → cache main". */
  title: string;
  /** "swarmy adds 2 variables to web and restarts it to pick them up." */
  say: string;
  lines: EnvLine[];
  /** Why this can't be done as asked (already wired, or wired to another of the kind). */
  blocked: string | null;
  /** A detach exists, so the toast can offer Undo. */
  undoable: boolean;
  /** Controls line: the call it makes. */
  tech: string;
}

/** "cache main", "Postgres checkout", "bucket storefront-media". */
export function storeWords(s: Pick<DataNodeSpec, 'kind' | 'name'>): string {
  return `${KIND_WORD[s.kind]} ${s.name}`;
}

const CALL: Record<DataNodeSpec['kind'], string> = {
  postgres: 'db.inject',
  cache: 'cache.attachToService',
  search: 'search.attachToService',
  vector: 'vector.attachToService',
  'object-storage': 'buckets.attachToService',
};

/** Connect part `from` (short name) to `to`; `all` are the app's stores, to spot one already of that kind. */
export function planConnect(from: string, to: DataNodeSpec, all: readonly DataNodeSpec[]): ConnectPlan {
  const n = to.env.length;
  const title = `${from} → ${storeWords(to)}`;
  const other = all.find((s) => s.kind === to.kind && s.id !== to.id && s.attached.includes(from));
  const blocked = to.attached.includes(from)
    ? `${from} already uses ${storeWords(to)}. Nothing to add.`
    : other
      ? `${from} already uses ${storeWords(other)}, and a part takes one ${KIND_WORD[to.kind]}. Change it on the Data tab first.`
      : null;
  return {
    title,
    say: `swarmy adds ${n === 1 ? 'one variable' : `${n} variables`} to ${from} and restarts it to pick ${n === 1 ? 'it' : 'them'} up.`,
    lines: to.env,
    blocked,
    undoable: to.kind !== 'postgres',
    tech: `${CALL[to.kind]} · ${to.kind === 'object-storage' ? 'its own read-write key' : 'joins the store’s private network'} · secrets mounted at /run/secrets`,
  };
}

/** Two parts of one app: they already share its network. "web reaches api at api:8080." */
export function reachWords(from: string, to: string, e: StackEndpoints | undefined): string {
  const s = e?.services.find((x) => x.short === to);
  const name = s ? typedName(s) : undefined;
  const at = name ? ` at ${hostPort(name.host, name.port)}` : '';
  return `${from} and ${to} are parts of the same app, so ${from} already reaches ${to}${at}. There is nothing to connect.`;
}
