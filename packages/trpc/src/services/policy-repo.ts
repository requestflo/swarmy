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
   * Seed the default set on first use, and top up any default added since
   * (matched by name) — additive only, never rewrites an existing row.
   */
  ensureDefaults(orgId: string, actorId?: string | null): Promise<void>;
  /** Replace the org's default rows with the current seeded set (custom rows untouched). */
  resetDefaults(orgId: string, actorId?: string | null): Promise<void>;
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

function defaultRows(orgId: string, actorId: string | null | undefined) {
  return defaultPolicyInputs().map((p) => ({
    orgId,
    name: p.name,
    effect: p.effect,
    source: p.source,
    priority: p.priority,
    enabled: true,
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
      const existing = await db.policy.findMany({
        where: { orgId, isdefault: true },
        select: { name: true },
      });
      // An org with rows but no default ones runs custom rules only (legacy
      // state); never seed defaults into it behind its back.
      if (existing.length === 0 && (await db.policy.count({ where: { orgId } })) > 0) return;
      const have = new Set(existing.map((r) => r.name));
      const missing = defaultRows(orgId, actorId).filter((r) => !have.has(r.name));
      if (missing.length) await db.policy.createMany({ data: missing });
    },

    async resetDefaults(orgId, actorId) {
      await db.$transaction([
        db.policy.deleteMany({ where: { orgId, isdefault: true } }),
        db.policy.createMany({ data: defaultRows(orgId, actorId) }),
      ]);
    },
  };
}

/** The repository for a request's db. One place to swap the implementation. */
export function policyRepo(db: DB): PolicyRepository {
  return prismaPolicyRepository(db);
}
