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
import { kvFor, newKvId, type KvCollection, type KvScope } from './swarm-kv.service';

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
  return orgs.map((o) => o.id).filter((id) => Boolean(scope.hub.managerNode(id)));
}
