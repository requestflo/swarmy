/**
 * Whole-app restore, its steps bound to swarmy's existing paths: stop and
 * start the app with `service.scale` (as a volume move pauses a service),
 * save and restore a volume through backups.service, and restore a database
 * through dbBackup.service, which takes its own safety copy first and refuses
 * when it can't (dbRestoreSafety.service).
 */
import type { AppRestorePart, AppRestoreScopeView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import type { AppRestoreSteps } from './appRestore.run';
import type { VolumeFacts } from './appRestore.inputs';
import { backupVolume, restoreSnapshot } from './backups.service';
import { restoreDb } from './dbBackup.service';
import { safetyBackupPlan } from './dbRestoreSafety.service';
import { resolveManagerNode } from './dispatch.service';
import { nodesRunning } from './volumeMove.service';

export interface StepTiming {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** How long the app may take to stop. */
  stopWaitMs?: number;
}

export interface StepInput {
  stack: string;
  scope: AppRestoreScopeView;
  facts: Map<string, VolumeFacts>;
  /** volume → the server that holds it. */
  volumeNodes: Map<string, string>;
}

export function bindSteps(ctx: OrgContext, input: StepInput, timing: StepTiming = {}): AppRestoreSteps {
  const sleep = timing.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = timing.now ?? Date.now;
  const { stack, scope, facts, volumeNodes } = input;
  const scale = async (service: string, replicas: number): Promise<void> => {
    const manager = await resolveManagerNode(ctx);
    await ctx.hub.dispatch(manager.id, 'service.scale', { service, replicas });
  };
  const startAll = async (): Promise<string | null> => {
    const failed: string[] = [];
    for (const s of scope.stops) {
      await scale(s.service, s.replicas).catch((e: unknown) => failed.push(`${s.service}: ${e instanceof Error ? e.message : String(e)}`));
    }
    return failed.length ? `these did not start again: ${failed.join('; ')}` : null;
  };
  const node = (part: AppRestorePart): string => volumeNodes.get(part.name)!;
  const dbMode = (part: AppRestorePart) => (part.method === 'pitr' ? ('pitr' as const) : ('in-place' as const));

  return {
    async stop() {
      try {
        for (const s of scope.stops) await scale(s.service, 0);
        const deadline = now() + (timing.stopWaitMs ?? 120_000);
        for (;;) {
          const running = scope.stops.filter((s) => nodesRunning(ctx, s.service).length > 0).map((s) => s.service);
          if (running.length === 0) return;
          if (now() >= deadline) throw new Error(`${running.join(', ')} did not stop`);
          await sleep(timing.pollMs ?? 2_000);
        }
      } catch (e) {
        await startAll();
        throw commandRejected(`${e instanceof Error ? e.message : String(e)}, so nothing was restored. ${stack} was started again.`);
      }
    },
    start: startAll,
    async saveVolume(part) {
      const targetId = facts.get(part.name)?.targets.get(part.pointId!);
      if (!targetId) throw new Error(`no destination is known for the save ${part.pointId}`);
      return (await backupVolume(ctx, { targetId, volume: part.name, nodeId: node(part) })).snapshotId;
    },
    async restoreVolume(part) {
      await restoreSnapshot(ctx, { snapshotId: part.pointId!, nodeId: node(part) });
    },
    async undoVolume(part, safetySnapshotId) {
      await restoreSnapshot(ctx, { snapshotId: safetySnapshotId, nodeId: node(part) });
    },
    async restoreDb(part, onSafety) {
      await restoreDb(
        ctx,
        {
          stack,
          cluster: part.name,
          engine: part.engine!,
          mode: dbMode(part),
          snapshotId: part.pointId ?? undefined,
          targetTime: part.method === 'pitr' ? new Date(part.at).toISOString() : undefined,
        },
        undefined,
        { onSafetyCopy: onSafety },
      );
    },
    async undoDb(part, safetySnapshotId) {
      // The safety copy is a logical dump: `pg_dumpall` before a PITR or a whole-cluster load, else `pg_dump`.
      const { engine } = safetyBackupPlan({ mode: dbMode(part), engine: part.engine! });
      await restoreDb(ctx, { stack, cluster: part.name, engine, mode: 'in-place', snapshotId: safetySnapshotId });
    },
  };
}
