import type { DB } from '@swarmy/db';

export type AuditActorType = 'user' | 'apikey' | 'system' | 'agent';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  actorType?: AuditActorType;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The first (and only) audit writer. Every mutating procedure — including
 * `system`-actor automation (polls, webhooks, GC, schedulers) — records here.
 * Audit failures never break the underlying mutation.
 */
export async function writeAudit(
  ctx: { db: DB; activeOrgId: string; user?: { id: string } | null },
  entry: AuditEntry,
): Promise<void> {
  const actorType = entry.actorType ?? 'user';
  try {
    await ctx.db.auditLog.create({
      data: {
        orgId: ctx.activeOrgId,
        actorType,
        actorId:
          entry.actorId !== undefined
            ? entry.actorId
            : actorType === 'user'
              ? (ctx.user?.id ?? null)
              : null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: (entry.metadata ?? {}) as object,
      },
    });
  } catch {
    // Audit is best-effort; do not surface to the caller.
  }
}
