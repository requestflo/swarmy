/**
 * Swarm-resource wire types (platform buildout spine): Docker secrets, Docker
 * configs, and the one-shot utility container (`container.runOnce`).
 *
 * Secrets/configs are Docker-truth (see docker-native-storage): the controller
 * never persists their values — a secret's data rides the already-authenticated
 * WS base64-encoded and goes straight into the Docker API. Docker never returns
 * secret data; configs ARE inspectable (`config.inspect` → `dataB64`).
 *
 * `runOnce` generalizes the short-lived sidecar pattern from
 * `apps/agent/src/handlers/backup.ts`: run an image with cmd/env/binds, wait
 * (killing at `timeoutMs`), collect the log tail, remove the container.
 *
 * Subpath: `@swarmy/core/protocol` (re-exported from `index.ts`).
 */
import { z } from 'zod';
import { CommandId, Timestamp } from './primitives';

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

// ── secret.create ────────────────────────────────────────────────────────────

export const SecretCreatePayload = z.object({
  ...cmd,
  name: z.string(),
  /** Secret value, base64-encoded (the Docker API's `Data` format). */
  dataB64: z.string(),
  /** e.g. `swarmy.secret.family` / `swarmy.secret.version` (E1 rotation). */
  labels: z.record(z.string()).optional(),
});
export const SecretCreateMsg = z.object({
  type: z.literal('secretCreate'),
  payload: SecretCreatePayload,
});
export type SecretCreateMsg = z.infer<typeof SecretCreateMsg>;
export type SecretCreatePayload = z.infer<typeof SecretCreatePayload>;

// ── secret.remove ────────────────────────────────────────────────────────────

export const SecretRemovePayload = z.object({ ...cmd, name: z.string() });
export const SecretRemoveMsg = z.object({
  type: z.literal('secretRemove'),
  payload: SecretRemovePayload,
});
export type SecretRemoveMsg = z.infer<typeof SecretRemoveMsg>;
export type SecretRemovePayload = z.infer<typeof SecretRemovePayload>;

// ── secret.list ──────────────────────────────────────────────────────────────

export const SecretListPayload = z.object({ ...cmd });
export const SecretListMsg = z.object({
  type: z.literal('secretList'),
  payload: SecretListPayload,
});
export type SecretListMsg = z.infer<typeof SecretListMsg>;
export type SecretListPayload = z.infer<typeof SecretListPayload>;

// ── config.create ────────────────────────────────────────────────────────────

export const ConfigCreatePayload = z.object({
  ...cmd,
  name: z.string(),
  /** Config contents, base64-encoded (the Docker API's `Data` format). */
  dataB64: z.string(),
  labels: z.record(z.string()).optional(),
});
export const ConfigCreateMsg = z.object({
  type: z.literal('configCreate'),
  payload: ConfigCreatePayload,
});
export type ConfigCreateMsg = z.infer<typeof ConfigCreateMsg>;
export type ConfigCreatePayload = z.infer<typeof ConfigCreatePayload>;

// ── config.remove ────────────────────────────────────────────────────────────

export const ConfigRemovePayload = z.object({ ...cmd, name: z.string() });
export const ConfigRemoveMsg = z.object({
  type: z.literal('configRemove'),
  payload: ConfigRemovePayload,
});
export type ConfigRemoveMsg = z.infer<typeof ConfigRemoveMsg>;
export type ConfigRemovePayload = z.infer<typeof ConfigRemovePayload>;

// ── config.list ──────────────────────────────────────────────────────────────

export const ConfigListPayload = z.object({ ...cmd });
export const ConfigListMsg = z.object({
  type: z.literal('configList'),
  payload: ConfigListPayload,
});
export type ConfigListMsg = z.infer<typeof ConfigListMsg>;
export type ConfigListPayload = z.infer<typeof ConfigListPayload>;

// ── config.inspect ───────────────────────────────────────────────────────────

export const ConfigInspectPayload = z.object({ ...cmd, name: z.string() });
export const ConfigInspectMsg = z.object({
  type: z.literal('configInspect'),
  payload: ConfigInspectPayload,
});
export type ConfigInspectMsg = z.infer<typeof ConfigInspectMsg>;
export type ConfigInspectPayload = z.infer<typeof ConfigInspectPayload>;

// ── container.runOnce ────────────────────────────────────────────────────────

export const RunOncePayload = z.object({
  ...cmd,
  image: z.string(),
  cmd: z.array(z.string()).optional(),
  /** Override the image ENTRYPOINT (e.g. ['/bin/sh','-c']) to run a tool directly. */
  entrypoint: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  /** Docker `Binds` entries (e.g. `volname:/data:ro`). */
  binds: z.array(z.string()).optional(),
  /** Networks to attach (e.g. a managed-db overlay) so the container resolves service DNS. */
  networks: z.array(z.string()).optional(),
  /** Pull the image first (best-effort). Defaults to true. */
  pull: z.boolean().default(true),
});
export const RunOnceMsg = z.object({
  type: z.literal('runOnce'),
  payload: RunOncePayload,
});
export type RunOnceMsg = z.infer<typeof RunOnceMsg>;
export type RunOncePayload = z.infer<typeof RunOncePayload>;

// ── result shapes (carried in CommandResultPayload.result) ────────────────────

/** One Docker secret/config as reported by list (values are never included). */
export const SwarmResourceInfo = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: Timestamp,
  labels: z.record(z.string()).default({}),
});
export type SwarmResourceInfo = z.infer<typeof SwarmResourceInfo>;

export const SecretCreateResult = z.object({ id: z.string(), name: z.string() });
export type SecretCreateResult = z.infer<typeof SecretCreateResult>;

export const SecretRemoveResult = z.object({ name: z.string(), removed: z.boolean() });
export type SecretRemoveResult = z.infer<typeof SecretRemoveResult>;

export const SecretListResult = z.object({
  secrets: z.array(SwarmResourceInfo).default([]),
});
export type SecretListResult = z.infer<typeof SecretListResult>;

export const ConfigCreateResult = z.object({ id: z.string(), name: z.string() });
export type ConfigCreateResult = z.infer<typeof ConfigCreateResult>;

export const ConfigRemoveResult = z.object({ name: z.string(), removed: z.boolean() });
export type ConfigRemoveResult = z.infer<typeof ConfigRemoveResult>;

export const ConfigListResult = z.object({
  configs: z.array(SwarmResourceInfo).default([]),
});
export type ConfigListResult = z.infer<typeof ConfigListResult>;

export const ConfigInspectResult = z.object({
  name: z.string(),
  /** Config contents, base64-encoded (Docker returns `Spec.Data` on inspect). */
  dataB64: z.string(),
  labels: z.record(z.string()).default({}),
  createdAt: Timestamp,
});
export type ConfigInspectResult = z.infer<typeof ConfigInspectResult>;

/** Max combined stdout+stderr the agent returns for a runOnce (tail-truncated). */
export const RUN_ONCE_OUTPUT_TAIL_BYTES = 64 * 1024;

export const RunOnceResult = z.object({
  exitCode: z.number().int(),
  /** Combined stdout+stderr, tail-truncated to ≤{@link RUN_ONCE_OUTPUT_TAIL_BYTES}. */
  output: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
  /** True when the container was killed at `timeoutMs`. */
  timedOut: z.boolean().optional(),
});
export type RunOnceResult = z.infer<typeof RunOnceResult>;
