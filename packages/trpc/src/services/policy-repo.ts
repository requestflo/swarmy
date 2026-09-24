import { defaultPolicyInputs } from '@swarmy/abac';
import type { DB } from '@swarmy/db';

/**
 * Where an org's ABAC policies live. The enforcement seam (`loadPolicyEngine`
 * in abac.ts) and the policy service talk ONLY to this interface, so moving
 * policies off Postgres (the docker-native-state work) is a new implementation
 * here, not an edit to the decision path. Today: the `Policy` table.
 */

export interface PolicyRecord {
  id: string;
  name: string;
  description: string | null;
  effect: 'permit' | 'forbid';
  source: string;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  updatedAt: Date;
}

export interface PolicyWrite {
  id?: string;
  name: string;
  description?: string | null;
  effect: 'permit' | 'forbid';
  source: string;
  priority?: number;
  enabled?: boolean;
}

export interface PolicyRepository {
  /** Every policy of the org (optionally enabled only), highest priority first. */
  list(orgId: string, opts?: { enabledOnly?: boolean }): Promise<PolicyRecord[]>;
  get(orgId: string, id: string): Promise<PolicyRecord | null>;
  /** Create (no id) or update (id, org-scoped). Returns null when the id is not in the org. */
  upsert(orgId: string, input: PolicyWrite, actorId?: string | null): Promise<PolicyRecord | null>;
  delete(orgId: string, id: string): Promise<boolean>;
  /**
   * Keep the org's default rows equal to the current seeded set (pre-launch,
   * no back-compat: defaults are managed by swarmy, not by the org). Seeds
   * them on first use and rewrites them whenever the shipped defaults change;
   * an admin's enable/disable of a default is kept by name. Custom rows are
   * never touched. Returns true when it wrote.
   */
  ensureDefaults(orgId: string, actorId?: string | null): Promise<boolean>;
}

interface PolicyRow {
  id: string;
  name: string;
  description?: string | null;
  effect: string;
  source: string;
  priority: number;
  enabled: boolean;
  isdefault?: boolean;
  updatedAt?: Date;
}

function toRecord(r: PolicyRow): PolicyRecord {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    effect: r.effect === 'forbid' ? 'forbid' : 'permit',
    source: r.source,
    priority: r.priority,
    enabled: r.enabled,
    isDefault: r.isdefault ?? false,
    updatedAt: r.updatedAt ?? new Date(0),
  };
}

/**
 * Pure: do the stored default rows differ from the shipped default set? Any
 * missing, extra or edited default row (name, effect, source, priority) is
 * drift. An org with no rows at all is not drift: the engine evaluates the
 * shipped defaults in memory.
 */
export function defaultsDrift(
  rows: Array<Pick<PolicyRecord, 'name' | 'effect' | 'source' | 'priority' | 'isDefault'>>,
): boolean {
  if (rows.length === 0) return false;
  const stored = rows.filter((r) => r.isDefault);
  const shipped = defaultPolicyInputs();
  if (stored.length !== shipped.length) return true;
  const byName = new Map(stored.map((r) => [r.name, r]));
  return shipped.some((d) => {
    const r = byName.get(d.name);
    return !r || r.effect !== d.effect || r.source !== d.source || r.priority !== d.priority;
  });
}

function defaultRows(orgId: string, actorId: string | null | undefined, disabled: Set<string> = new Set()) {
  return defaultPolicyInputs().map((p) => ({
    orgId,
    name: p.name,
    effect: p.effect,
    source: p.source,
    priority: p.priority,
    enabled: !disabled.has(p.name),
    isdefault: true,
    createdById: actorId ?? null,
  }));
}

/** The Prisma-backed repository (the `policy` table). */
export function prismaPolicyRepository(db: DB): PolicyRepository {
  return {
    async list(orgId, opts) {
      const rows = await db.policy.findMany({
        where: { orgId, ...(opts?.enabledOnly ? { enabled: true } : {}) },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      });
      return (rows as PolicyRow[]).map(toRecord);
    },

    async get(orgId, id) {
      const row = await db.policy.findFirst({ where: { id, orgId } });
      return row ? toRecord(row as PolicyRow) : null;
    },

    async upsert(orgId, input, actorId) {
      if (input.id) {
        const existing = await db.policy.findFirst({ where: { id: input.id, orgId }, select: { id: true } });
        if (!existing) return null;
        const row = await db.policy.update({
          where: { id: input.id },
          data: {
            name: input.name,
            description: input.description ?? null,
            effect: input.effect,
            source: input.source,
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          },
        });
        return toRecord(row as PolicyRow);
      }
      const row = await db.policy.create({
        data: {
          orgId,
          name: input.name,
          description: input.description ?? null,
          effect: input.effect,
          source: input.source,
          priority: input.priority ?? 0,
          enabled: input.enabled ?? true,
          isdefault: false,
          createdById: actorId ?? null,
        },
      });
      return toRecord(row as PolicyRow);
    },

    async delete(orgId, id) {
      const res = await db.policy.deleteMany({ where: { id, orgId } });
      return res.count > 0;
    },

    async ensureDefaults(orgId, actorId) {
      const all = (await db.policy.findMany({ where: { orgId } })) as PolicyRow[];
      const records = all.map(toRecord);
      const hasDefaults = records.some((r) => r.isDefault);
      if (hasDefaults && !defaultsDrift(records)) return false;
      const disabled = new Set(records.filter((r) => r.isDefault && !r.enabled).map((r) => r.name));
      await db.$transaction([
        db.policy.deleteMany({ where: { orgId, isdefault: true } }),
        db.policy.createMany({ data: defaultRows(orgId, actorId, disabled) }),
      ]);
      return true;
    },

  };
}

/** The repository for a request's db. One place to swap the implementation. */
export function policyRepo(db: DB): PolicyRepository {
  return prismaPolicyRepository(db);
}
