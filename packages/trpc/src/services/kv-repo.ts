/**
 * Repository helpers over swarm-kv (plans/epic-docker-native-state.md P4).
 *
 * Each class-(b) model has a small repository in `*.repo.ts` built from these
 * two shapes, so services keep their public API and only the storage behind
 * the repository changes:
 *
 *  - {@link orgSingleton}: one document per org (IngressConfig, MeshConfig, …),
 *    id = orgId. `get` returns the model's defaults when nothing is stored and
 *    never writes (reads must not grow raft).
 *  - {@link orgCollection}: many rows per org (BackupTarget, DnsZone, Stack, …),
 *    one document per row, id = a cuid-shaped {@link newKvId}. Filtering and
 *    ordering happen in memory: the store is small by construction.
 *
 * Rows carry `id`, `orgId`, `createdAt` and `updatedAt` like the Prisma rows
 * they replace. `updatedAt` is the latest version's Docker CreatedAt (never
 * stored); `createdAt` is written once on create (immutable, not run state).
 */
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { isKvRestorePending, kvFor, newKvId, type KvCollection, type KvScope } from './swarm-kv.service';

export type { KvScope };

/** A repository row: the stored document plus identity + timestamps. */
export type KvRow<D> = D & { id: string; orgId: string; createdAt: Date; updatedAt: Date };

type Stored<D> = D & { createdAt?: string };

function toRow<D extends object>(
  orgId: string,
  id: string,
  value: Stored<D>,
  updatedAtMs: number,
): KvRow<D> {
  const { createdAt, ...rest } = value;
  const updatedAt = new Date(updatedAtMs || Date.now());
  return {
    ...(rest as unknown as D),
    id,
    orgId,
    createdAt: createdAt ? new Date(createdAt) : updatedAt,
    updatedAt,
  };
}

/** Strip row-only fields so they never reach raft. */
function toDoc<D extends object>(row: Partial<KvRow<D>> | D): D {
  const { id: _id, orgId: _orgId, createdAt: _c, updatedAt: _u, ...rest } = row as KvRow<D>;
  return rest as unknown as D;
}

export type Patch<D> = Partial<D> | ((current: D) => Partial<D> | undefined);

/** One document per org. */
export function orgSingleton<D extends object>(collection: KvCollection, defaults: () => D) {
  return {
    collection,
    defaults,
    /** The stored row, or null when this org has never saved one. */
    async find(scope: KvScope, orgId: string): Promise<KvRow<D> | null> {
      const doc = await kvFor(scope, orgId).getDoc<Stored<D>>(collection, orgId);
      return doc ? toRow<D>(orgId, orgId, { ...defaults(), ...doc.value }, doc.updatedAt) : null;
    },
    /** The stored row, or the defaults (not written). */
    async get(scope: KvScope, orgId: string): Promise<KvRow<D>> {
      return (await this.find(scope, orgId)) ?? toRow<D>(orgId, orgId, defaults() as Stored<D>, 0);
    },
    /** Merge a patch (or the result of `patch(current)`) and write it (CAS). */
    async update(scope: KvScope, orgId: string, patch: Patch<D>): Promise<KvRow<D>> {
      const doc = await kvFor(scope, orgId).update<Stored<D>>(collection, orgId, (cur) => {
        const base = { ...defaults(), ...(cur ?? {}) } as Stored<D>;
        const delta = typeof patch === 'function' ? patch(toDoc<D>(base as D)) : patch;
        if (delta === undefined) return undefined;
        return { ...base, ...toDoc<D>(delta as D) } as Stored<D>;
      });
      return doc ? toRow<D>(orgId, orgId, { ...defaults(), ...doc.value }, doc.updatedAt) : this.get(scope, orgId);
    },
    async remove(scope: KvScope, orgId: string): Promise<boolean> {
      return kvFor(scope, orgId).delete(collection, orgId);
    },
    /**
     * Cross-org scan for workers: every org (with a connected manager) that
     * has stored this document. Orgs whose swarm can't be reached are skipped.
     */
    async listAll(scope: { hub: AgentHub; db: DB }): Promise<KvRow<D>[]> {
      const out: KvRow<D>[] = [];
      for (const orgId of await reachableOrgIds(scope)) {
        const row = await this.find(scope, orgId).catch(() => null);
        if (row) out.push(row);
      }
      return out;
    },
  };
}

/** Many rows per org, one document per row. */
export function orgCollection<D extends object>(collection: KvCollection, defaults: () => Partial<D> = () => ({})) {
  const rowOf = (orgId: string, id: string, value: Stored<D>, updatedAt: number) =>
    toRow<D>(orgId, id, { ...(defaults() as D), ...value }, updatedAt);
  return {
    collection,
    async list(scope: KvScope, orgId: string, where?: (row: KvRow<D>) => boolean): Promise<KvRow<D>[]> {
      const docs = await kvFor(scope, orgId).list<Stored<D>>(collection);
      const rows = docs.map((d) => rowOf(orgId, d.id, d.value, d.updatedAt));
      return where ? rows.filter(where) : rows;
    },
    async find(scope: KvScope, orgId: string, id: string): Promise<KvRow<D> | null> {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(id)) return null; // never a valid key ⇒ not found
      const doc = await kvFor(scope, orgId).getDoc<Stored<D>>(collection, id);
      return doc ? rowOf(orgId, id, doc.value, doc.updatedAt) : null;
    },
    async findFirst(scope: KvScope, orgId: string, where: (row: KvRow<D>) => boolean): Promise<KvRow<D> | null> {
      return (await this.list(scope, orgId, where))[0] ?? null;
    },
    async create(scope: KvScope, orgId: string, data: D, id: string = newKvId()): Promise<KvRow<D>> {
      const value = { ...(defaults() as D), ...toDoc<D>(data), createdAt: new Date().toISOString() } as Stored<D>;
      const doc = await kvFor(scope, orgId).put<Stored<D>>(collection, id, value);
      return rowOf(orgId, id, doc.value, doc.updatedAt);
    },
    /** Merge a patch into an existing row (CAS). Null when the row doesn't exist. */
    async update(scope: KvScope, orgId: string, id: string, patch: Patch<D>): Promise<KvRow<D> | null> {
      let missing = false;
      const doc = await kvFor(scope, orgId).update<Stored<D>>(collection, id, (cur) => {
        if (!cur) {
          missing = true;
          return undefined;
        }
        const delta = typeof patch === 'function' ? patch(toDoc<D>(cur as D)) : patch;
        if (delta === undefined) return undefined;
        return { ...cur, ...toDoc<D>(delta as D) } as Stored<D>;
      });
      if (missing || !doc) return null;
      return rowOf(orgId, id, doc.value, doc.updatedAt);
    },
    async remove(scope: KvScope, orgId: string, id: string): Promise<boolean> {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(id)) return false;
      return kvFor(scope, orgId).delete(collection, id);
    },
    async removeWhere(scope: KvScope, orgId: string, where: (row: KvRow<D>) => boolean): Promise<number> {
      let n = 0;
      for (const row of await this.list(scope, orgId, where)) {
        if (await this.remove(scope, orgId, row.id)) n += 1;
      }
      return n;
    },
    /** Cross-org scan for workers (orgs whose swarm can't be reached are skipped). */
    async listAll(scope: { hub: AgentHub; db: DB }, where?: (row: KvRow<D>) => boolean): Promise<KvRow<D>[]> {
      const out: KvRow<D>[] = [];
      for (const orgId of await reachableOrgIds(scope)) {
        out.push(...(await this.list(scope, orgId, where).catch(() => [] as KvRow<D>[])));
      }
      return out;
    },
  };
}

/** Org ids whose swarm-kv can be read now (a manager agent is connected). */
export async function reachableOrgIds(scope: { hub: AgentHub; db: DB }): Promise<string[]> {
  const orgs = await scope.db.organization.findMany({ select: { id: true } });
  return orgs.map((o) => o.id).filter((id) => Boolean(scope.hub.managerNode(id)) && !isKvRestorePending(id));
}

// ── Prisma-shaped table over an org collection ────────────────────────────────

/**
 * Where-clause subset a {@link kvTable} understands. Anything else throws —
 * a filter silently ignored would return (and act on) the wrong rows.
 */
type WhereValue =
  | string
  | number
  | boolean
  | null
  | Date
  | { startsWith: string }
  | { in: readonly unknown[] }
  | { not: unknown };

export type KvWhere = Record<string, WhereValue | undefined>;

export interface KvFindArgs {
  where?: KvWhere;
  orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
  take?: number;
  /** Accepted for call-site compatibility; full rows are returned. */
  select?: unknown;
}

function norm(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function matchWhere(row: Record<string, unknown>, where: KvWhere | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const v = row[k] ?? null;
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
      if (norm(v) !== norm(cond)) return false;
      continue;
    }
    if ('startsWith' in cond) {
      if (typeof v !== 'string' || !v.startsWith(cond.startsWith)) return false;
    } else if ('in' in cond) {
      if (!cond.in.map(norm).includes(norm(v))) return false;
    } else if ('not' in cond) {
      if (norm(v) === norm(cond.not)) return false;
    } else {
      throw new Error(`kvTable: unsupported filter on "${k}": ${JSON.stringify(cond)}`);
    }
  }
  return true;
}

function sortRows<R extends Record<string, unknown>>(rows: R[], orderBy: KvFindArgs['orderBy']): R[] {
  const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o)) : [];
  if (!keys.length) return rows;
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = norm(a[k]) as number | string | null;
      const y = norm(b[k]) as number | string | null;
      if (x === y) continue;
      const c = x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
      return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

/**
 * A Prisma-delegate-shaped repository over one org collection, so services
 * whose queries are simple filters keep their shape. Date fields round-trip as
 * ISO strings in the document and `Date`s on the row. `unique` lists field
 * sets that must be unique per org (checked on create — one controller writes).
 */
export function kvTable<D extends object>(
  collection: KvCollection,
  opts: { dateFields?: readonly string[]; defaults?: () => Partial<D>; unique?: ReadonlyArray<readonly string[]> } = {},
) {
  const coll = orgCollection<Record<string, unknown>>(collection, opts.defaults as never);
  const dates = new Set(opts.dateFields ?? []);
  type Row = KvRow<D>;
  const toRowDates = (r: KvRow<Record<string, unknown>>): Row => {
    const out: Record<string, unknown> = { ...r };
    for (const f of dates) out[f] = typeof out[f] === 'string' ? new Date(out[f] as string) : (out[f] ?? null);
    return out as Row;
  };
  const toDocDates = (d: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...d };
    for (const f of dates) if (out[f] instanceof Date) out[f] = (out[f] as Date).toISOString();
    return out;
  };
  const clean = (d: Record<string, unknown>) => {
    const { id: _i, orgId: _o, createdAt: _c, updatedAt: _u, ...rest } = d;
    return toDocDates(rest);
  };

  return (scope: KvScope, orgId: string) => {
    const all = async (): Promise<Row[]> => (await coll.list(scope, orgId)).map(toRowDates);
    const scoped = (where?: KvWhere) => {
      if (where?.orgId !== undefined && where.orgId !== orgId) return null; // another org: nothing
      const { orgId: _o, ...rest } = where ?? {};
      return rest as KvWhere;
    };
    const api = {
      async findMany(args: KvFindArgs = {}): Promise<Row[]> {
        const where = scoped(args.where);
        if (!where) return [];
        const rows = sortRows((await all()).filter((r) => matchWhere(r as never, where)) as never[], args.orderBy);
        return (args.take ? rows.slice(0, args.take) : rows) as Row[];
      },
      async findFirst(args: KvFindArgs = {}): Promise<Row | null> {
        return (await api.findMany({ ...args, take: 1 }))[0] ?? null;
      },
      async findUnique(args: { where: KvWhere; select?: unknown }): Promise<Row | null> {
        return api.findFirst({ where: args.where });
      },
      async count(args: { where?: KvWhere } = {}): Promise<number> {
        return (await api.findMany({ where: args.where })).length;
      },
      async create(args: { data: Partial<D> & Record<string, unknown> }): Promise<Row> {
        const data = clean(args.data as Record<string, unknown>);
        for (const fields of opts.unique ?? []) {
          const clash = (await all()).find((r) =>
            fields.every((f) => norm((r as Record<string, unknown>)[f] ?? null) === norm(data[f] ?? null)),
          );
          if (clash) {
            const err = new Error(`Unique constraint failed on ${collection} (${fields.join(', ')})`) as Error & { code: string };
            err.code = 'P2002';
            throw err;
          }
        }
        const id = typeof args.data.id === 'string' ? args.data.id : undefined;
        return toRowDates(await coll.create(scope, orgId, data, id));
      },
      /** Update one row by id (or the first match); throws when missing, like Prisma. */
      async update(args: { where: KvWhere; data: Partial<D> & Record<string, unknown> }): Promise<Row> {
        const target = typeof args.where.id === 'string' ? { id: args.where.id } : await api.findFirst({ where: args.where });
        const id = target?.id as string | undefined;
        const row = id ? await coll.update(scope, orgId, id, clean(args.data as Record<string, unknown>)) : null;
        if (!row) {
          const err = new Error(`No ${collection} record found to update`) as Error & { code: string };
          err.code = 'P2025';
          throw err;
        }
        return toRowDates(row);
      },
      async updateMany(args: { where?: KvWhere; data: Partial<D> & Record<string, unknown> }): Promise<{ count: number }> {
        const rows = await api.findMany({ where: args.where });
        for (const r of rows) await coll.update(scope, orgId, r.id, clean(args.data as Record<string, unknown>));
        return { count: rows.length };
      },
      async delete(args: { where: KvWhere }): Promise<Row> {
        const row = await api.findFirst({ where: args.where });
        if (!row || !(await coll.remove(scope, orgId, row.id))) {
          const err = new Error(`No ${collection} record found to delete`) as Error & { code: string };
          err.code = 'P2025';
          throw err;
        }
        return row;
      },
      async deleteMany(args: { where?: KvWhere } = {}): Promise<{ count: number }> {
        const rows = await api.findMany({ where: args.where });
        for (const r of rows) await coll.remove(scope, orgId, r.id);
        return { count: rows.length };
      },
    };
    return api;
  };
}
