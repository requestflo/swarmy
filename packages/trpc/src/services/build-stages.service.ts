/**
 * Writes a build's stage history (`BuildStage` rows) as the build goes.
 *
 * - clone → build → push: {@link followBuilderStages} listens for the builder's
 *   `buildStage` frames (only from the node the build was dispatched to) and
 *   closes the open stage when the next begins or the build ends.
 * - scan → sign: {@link timeStage} around the controller's own work.
 * - rollout: `build-rollout.service.ts`.
 *
 * Every write is best-effort: stage history never delays or fails a build.
 * One row per (build, stage), so concurrent writers never race on a blob.
 */
import type { DB } from '@swarmy/db';
import type { BuildStageKey, BuilderStage } from '@swarmy/core/protocol';
import { buildStageBus } from './build-stage-bus';
import { failureLine, type FinishedOutcome, type StageFacts } from './build-stages';

export type StageDb = Pick<DB, 'buildStage'>;

/** Begin a stage (a second start — a re-deploy — keeps the first start time). */
export async function startStage(db: StageDb, buildId: string, stage: BuildStageKey, at = new Date()): Promise<void> {
  await db.buildStage
    .upsert({
      where: { buildId_stage: { buildId, stage } },
      create: { buildId, stage, startedAt: at },
      update: { finishedAt: null, outcome: 'running' },
    })
    .catch(() => undefined);
}

/** End a stage with its outcome (no-op when it never started). */
export async function finishStage(
  db: StageDb,
  buildId: string,
  stage: BuildStageKey,
  outcome: FinishedOutcome,
  facts?: StageFacts,
  at = new Date(),
): Promise<void> {
  await db.buildStage
    .updateMany({
      where: { buildId, stage },
      data: { finishedAt: at, outcome, ...(facts ? { factsJson: facts as object } : {}) },
    })
    .catch(() => undefined);
}

/** Record what a running stage knows so far (e.g. 2 of 3 copies up). */
export async function noteStage(db: StageDb, buildId: string, stage: BuildStageKey, facts: StageFacts): Promise<void> {
  await db.buildStage
    .updateMany({ where: { buildId, stage, finishedAt: null }, data: { factsJson: facts as object } })
    .catch(() => undefined);
}

/**
 * Time one controller stage around `fn`. `judge` turns its result into the
 * outcome; a throw marks the stage failed and is rethrown. No `buildId`
 * (a manual rescan) → just runs `fn`.
 */
export async function timeStage<T>(
  db: StageDb,
  buildId: string | undefined,
  stage: BuildStageKey,
  fn: () => Promise<T>,
  judge: (r: T) => { outcome: FinishedOutcome; facts?: StageFacts } = () => ({ outcome: 'ok' }),
): Promise<T> {
  if (!buildId) return fn();
  await startStage(db, buildId, stage);
  try {
    const r = await fn();
    const j = judge(r);
    await finishStage(db, buildId, stage, j.outcome, j.facts);
    return r;
  } catch (e) {
    await finishStage(db, buildId, stage, 'failed', { error: failureLine(e) });
    throw e;
  }
}

/** Follow the builder's clone → build → push for one dispatched build. */
export function followBuilderStages(
  db: StageDb,
  input: { buildId: string; commandId: string; nodeId: string },
): { settle(outcome: 'ok' | 'failed', error?: unknown): Promise<void> } {
  let open: BuilderStage | null = null;
  let chain: Promise<void> = Promise.resolve();
  const off = buildStageBus.on(input.commandId, (e) => {
    if (e.nodeId !== input.nodeId) return;
    chain = chain.then(async () => {
      if (open) await finishStage(db, input.buildId, open, 'ok', undefined, e.at);
      open = e.stage;
      await startStage(db, input.buildId, e.stage, e.at);
    });
  });
  return {
    async settle(outcome, error) {
      off();
      await chain;
      if (!open) return;
      await finishStage(db, input.buildId, open, outcome, outcome === 'failed' ? { error: failureLine(error) } : undefined);
      open = null;
    },
  };
}
