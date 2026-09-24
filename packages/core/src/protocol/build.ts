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
  /**
   * Exact commit to build (git-apps). When set, the builder fetches this sha
   * (depth 1) and checks it out instead of cloning the tip of `ref`, so a
   * webhook for commit A never builds a later commit B. Additive.
   */
  sha: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
  /** HTTPS username paired with `token` (`x-access-token` GitHub, `oauth2` GitLab). */
  tokenUser: z.string().optional(),
  /** OpenSSH private deploy key for ssh:// / scp-style URLs (resolved, never layered). */
  sshKey: z.string().optional(),
});
export type GitBuildSource = z.infer<typeof GitBuildSource>;

/** Env var names (build-time env, Railpack config). */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/**
 * How to turn the source into an image. `auto` = the Dockerfile when one is at
 * `source.dockerfile` in the context, else Railpack. ABSENT = `dockerfile`
 * (older controllers), so the program an old payload renders never changes.
 */
export const BuildBuilder = z.enum(['auto', 'dockerfile', 'railpack']);
export type BuildBuilder = z.infer<typeof BuildBuilder>;

/**
 * Railpack (zero-config) options. The builder runs `railpack prepare` (the
 * CLI shipped inside the frontend image, so plan and frontend are the SAME
 * version), then `buildctl build --frontend gateway.v0` with that frontend.
 * Every value here is optional; with none set Railpack detects everything.
 */
export const RailpackBuildOptions = z.object({
  /** Frontend image (also carries `/railpack`). Default: the pinned BOM ref. */
  frontendImage: z.string().min(1).optional(),
  /** Image `railpack prepare` runs in (needs sh + bash). Default: the pinned BOM ref. */
  prepareImage: z.string().min(1).optional(),
  /**
   * Plan image rewrites: the exact tag refs a plan names (railpack-builder /
   * railpack-runtime) → digest-pinned or mirrored refs. Default: the BOM pins.
   */
  imageRewrites: z.record(z.string().min(1)).optional(),
  /** Override the install step (`RAILPACK_INSTALL_CMD`). */
  installCmd: z.string().min(1).optional(),
  /** Override the build step (`--build-cmd`). */
  buildCmd: z.string().min(1).optional(),
  /** Override the start command baked into the image (`--start-cmd`). */
  startCmd: z.string().min(1).optional(),
  /** Mise tools, e.g. `node@22`, `python@3.12` (`RAILPACK_PACKAGES`). */
  packages: z.array(z.string().min(1)).optional(),
  /** apt packages for the build image (`RAILPACK_BUILD_APT_PACKAGES`). */
  buildAptPackages: z.array(z.string().min(1)).optional(),
  /** apt packages for the runtime image (`RAILPACK_DEPLOY_APT_PACKAGES`). */
  deployAptPackages: z.array(z.string().min(1)).optional(),
  /**
   * Build-time env. Railpack mounts these as BuildKit SECRETS in its steps:
   * values ride the builder container env, never the program text, the plan
   * (names only) or an image layer.
   */
  env: z.record(EnvName, z.string()).optional(),
  /** Prefix for Railpack's cache-mount ids (isolates apps sharing a builder). */
  cacheKey: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
});
export type RailpackBuildOptions = z.infer<typeof RailpackBuildOptions>;

/**
 * Registry build cache (`--import-cache/--export-cache type=registry`) in the
 * in-swarm registry. A missing import ref is a cold build, never a failure;
 * a failed export (`ignore-error=true`) never fails the build.
 */
export const BuildCacheOptions = z.object({
  /** Refs to warm from, in order (the branch's cache, then the default branch's). */
  importRefs: z.array(z.string().min(1)).max(4).optional(),
  /** Ref to write this build's cache to. */
  exportRef: z.string().min(1).optional(),
  /** `max` also exports intermediate stages (the useful one for multi-stage/Railpack). */
  mode: z.enum(['min', 'max']).default('max'),
});
export type BuildCacheOptions = z.infer<typeof BuildCacheOptions>;

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
  /**
   * Extra PULL logins for private `FROM` bases (org third-party registry
   * credentials, attached by the controller hub decorator). Merged into the
   * one-shot docker config's `auths` keyed by `server`; never layered. Additive
   * — older agents ignore it.
   */
  pullAuths: z.array(RegistryAuth).optional(),
  pushPolicy: z.enum(['always', 'never']).default('always'),
  /** Builder image that wraps BuildKit/`buildctl` (or `img`). */
  builderImage: z.string().optional(),
  /**
   * The controller's assertion that this node carries the builder role
   * (`swarmy.node.builder=true`, read live at dispatch). The agent's gate
   * (`buildGateAllows`) honours it unless `SWARMY_ALLOW_BUILD` explicitly
   * overrides. Absent (older controller) ⇒ default-off.
   */
  builderCapable: z.boolean().optional(),
  /** Dockerfile vs Railpack (additive; absent = dockerfile, see {@link BuildBuilder}). */
  builder: BuildBuilder.optional(),
  railpack: RailpackBuildOptions.optional(),
  cache: BuildCacheOptions.optional(),
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
  /** At least one step was served from cache. */
  cacheHit?: boolean;
  /** Steps BuildKit reported `CACHED` (the warm-build signal). */
  cachedSteps?: number;
  /** Which builder actually ran (after `auto` resolved). */
  builder?: 'dockerfile' | 'railpack';
  /** What Railpack detected (from `railpack prepare --info-out` + the plan). */
  railpack?: RailpackBuildInfo;
}

/** The slice of Railpack's build info swarmy keeps. */
export interface RailpackBuildInfo {
  version?: string;
  /** e.g. `["node"]`. */
  providers: string[];
  /** Resolved tool versions, e.g. `{ node: "22.23.2" }`. */
  packages: Record<string, string>;
  /** Provider metadata (`nodePackageManager`, framework hints, …). */
  metadata: Record<string, string>;
  /** The start command baked into the image. */
  startCommand?: string;
}
