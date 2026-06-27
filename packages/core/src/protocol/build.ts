/**
 * Git CI/CD build protocol (epic: git-cicd-registry, MVP).
 *
 * A `buildImage` is a controller→agent command that runs a BuildKit/`buildctl`
 * (or `img`) container via dockerode on a builder-labeled node: it shallow-clones
 * the git source, builds the Dockerfile, and pushes the resulting image to the
 * target (in-swarm) registry. It is long-running and streams `logChunk`s keyed by
 * `commandId` (reusing the existing log plumbing), terminating in a
 * `commandResult` carrying `{ imageRef, digest }`.
 *
 * Secrets indirection: the git token and registry password are injected at
 * dispatch time by the controller (resolved from the encrypted vault) and never
 * persisted in the build record. The wire payload below is the resolved form the
 * agent receives over the authenticated WS.
 *
 * Added to `ControllerToAgentMessage` (messages.ts) and `CommandResultMap`
 * (results.ts); `image.build` is registered in `COMMAND_PROTOCOL_TYPE`
 * (packages/trpc/src/hub/types.ts). See INTEGRATION.
 *
 * Subpath: `@swarmy/core/protocol`.
 */
import { z } from 'zod';
import { CommandId } from './primitives';
import { RegistryAuth } from './commands';

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

/** Git source to build from (token is the resolved value, injected at dispatch). */
export const GitBuildSource = z.object({
  url: z.string().min(1),
  ref: z.string().min(1).default('main'),
  /** Resolved PAT / deploy-key value, mounted as a BuildKit secret — never layered. */
  token: z.string().optional(),
  /** Build-context subdir within the repo (default: repo root). */
  subdir: z.string().optional(),
  /** Dockerfile path relative to the context (default: `Dockerfile`). */
  dockerfile: z.string().optional(),
});
export type GitBuildSource = z.infer<typeof GitBuildSource>;

export const BuildImagePayload = z.object({
  ...cmd,
  source: GitBuildSource,
  /** Fully-qualified target image refs to tag + push, e.g. `registry:5000/app:sha`. */
  imageRefs: z.array(z.string().min(1)).nonempty(),
  buildArgs: z.record(z.string()).optional(),
  target: z.string().optional(),
  platform: z.string().optional(),
  /** Registry to push to (resolved creds, injected at dispatch). */
  registryAuth: RegistryAuth.optional(),
  pushPolicy: z.enum(['always', 'never']).default('always'),
  /** Builder image that wraps BuildKit/`buildctl` (or `img`). */
  builderImage: z.string().optional(),
});
export type BuildImagePayload = z.infer<typeof BuildImagePayload>;

export const BuildImageMsg = z.object({
  type: z.literal('buildImage'),
  payload: BuildImagePayload,
});
export type BuildImageMsg = z.infer<typeof BuildImageMsg>;

/** Terminal `commandResult.result` for a `buildImage`. Mirrors `CommandResultMap`. */
export interface BuildImageResult {
  imageRef: string;
  imageRefs: string[];
  digest: string;
  sizeBytes?: number;
  cacheHit?: boolean;
}
