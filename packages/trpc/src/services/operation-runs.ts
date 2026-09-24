/**
 * Resumable operation state in the controller store (`OperationRun`).
 *
 * Long-running, step-by-step operations (moving the swarm onto the mesh, a
 * Garage engine upgrade) persist their progress so a controller restart can
 * resume them. That progress is RUN STATE — rewritten every step — so it lives
 * here and never in the swarm-kv documents of the config it belongs to
 * (plans/epic-docker-native-state.md: no timestamp, counter or run state in raft).
 */
import type { DB } from '@swarmy/db';

export type OperationKind = 'mesh.migration' | 'storage.engineUpgrade' | 'node.decommission';

type RunsDb = Pick<DB, 'operationRun'>;

export async function readOperationRun<T>(db: RunsDb, orgId: string, kind: OperationKind): Promise<T | null> {
  const row = await db.operationRun.findUnique({ where: { orgId_kind: { orgId, kind } } });
  return (row?.run as T | null | undefined) ?? null;
}

export async function saveOperationRun<T>(db: RunsDb, orgId: string, kind: OperationKind, run: T): Promise<void> {
  const data = run as unknown as object;
  await db.operationRun.upsert({
    where: { orgId_kind: { orgId, kind } },
    create: { orgId, kind, run: data },
    update: { run: data },
  });
}

/** Every org's persisted run of one kind (resume-after-restart scans). */
export async function listOperationRuns<T>(db: RunsDb, kind: OperationKind): Promise<Array<{ orgId: string; run: T }>> {
  const rows = await db.operationRun.findMany({ where: { kind }, select: { orgId: true, run: true } });
  return rows.map((r) => ({ orgId: r.orgId, run: r.run as T }));
}
