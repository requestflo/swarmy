/**
 * Build stage progress (the build page's stage rail).
 *
 * A build is six timed stages: clone → build → push run inside the builder
 * container, so the AGENT reports when each one begins; scan → sign → rollout
 * are the controller's own work and it times them itself.
 *
 * `buildStage` is an agent→controller frame meaning "this build (by its
 * `image.build` commandId) entered `stage` now"; entering a stage ends the one
 * before it, and the build's `commandResult` ends the last. Additive: an agent
 * only sends it when the `buildImage` payload asked with `reportStages: true`,
 * so an older controller (whose union lacks the frame) never receives one, and
 * an older agent simply never reports stages.
 *
 * Subpath: `@swarmy/core/protocol`.
 */
import { z } from 'zod';
import { CommandId } from './primitives';

/** Every stage a build page shows, in order. */
export const BUILD_STAGE_ORDER = ['clone', 'build', 'push', 'scan', 'sign', 'rollout'] as const;
export const BuildStageKey = z.enum(BUILD_STAGE_ORDER);
export type BuildStageKey = z.infer<typeof BuildStageKey>;

/** The stages the builder container runs (and so the agent reports). */
export const BuilderStage = z.enum(['clone', 'build', 'push']);
export type BuilderStage = z.infer<typeof BuilderStage>;

export const BuildStagePayload = z.object({
  /** The `buildImage` command's id (== the build's `logsRef`). */
  commandId: CommandId,
  stage: BuilderStage,
});
export type BuildStagePayload = z.infer<typeof BuildStagePayload>;

export const BuildStageMsg = z.object({
  type: z.literal('buildStage'),
  payload: BuildStagePayload,
});
export type BuildStageMsg = z.infer<typeof BuildStageMsg>;
