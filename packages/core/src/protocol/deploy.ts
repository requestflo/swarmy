/**
 * Deploy progress (the Deploying screen's live tracker + log).
 *
 * A traced deploy gets a `deployId` on the controller. Each `deployService`
 * it dispatches carries `watch: { deployId, stack, role }`; the manager agent
 * that creates the service then watches it for a bounded time (best-effort,
 * never blocking the command) and streams `deployProgress` frames back:
 *
 *   pull   the image downloading on the task's node (layers, bytes, digest)
 *   data   a companion (its database, cache…) starting — role `data`
 *   start  the app's tasks going 0/1 → starting → 1/1 running
 *
 * The controller adds the stages it owns (managed data provisioning, the
 * route + certificate, the health check) to the same per-deploy stream.
 *
 * `message` is DISPLAY-SAFE by contract: an image ref, a service name, a
 * count, a Docker task state. Never an env value, a secret or a registry
 * credential. Additive: an agent only sends `deployProgress` when the
 * controller asked for it with `watch`, so an older controller (whose union
 * lacks the frame) never receives one.
 *
 * Subpath: `@swarmy/core/protocol`.
 */
import { z } from 'zod';
import { Timestamp } from './primitives';

/** The five tracker steps, in order. */
export const DeployStage = z.enum(['pull', 'data', 'start', 'route', 'health']);
export type DeployStage = z.infer<typeof DeployStage>;

export const DeployEventStatus = z.enum(['started', 'progress', 'done', 'failed']);
export type DeployEventStatus = z.infer<typeof DeployEventStatus>;

/** Controller-minted id of one traced deploy (`dep_<base36>`). */
export const DeployId = z.string().regex(/^dep_[a-z0-9]{8,40}$/);
export type DeployId = z.infer<typeof DeployId>;

/** Structured numbers behind a message (all optional, all display-safe). */
export const DeployEventDetail = z.object({
  layersTotal: z.number().int().nonnegative().optional(),
  layersDone: z.number().int().nonnegative().optional(),
  bytesTotal: z.number().int().nonnegative().optional(),
  bytesDone: z.number().int().nonnegative().optional(),
  /** `sha256:…` of the pulled image. */
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  image: z.string().max(300).optional(),
  replicasRunning: z.number().int().nonnegative().optional(),
  replicasDesired: z.number().int().nonnegative().optional(),
  host: z.string().max(253).optional(),
});
export type DeployEventDetail = z.infer<typeof DeployEventDetail>;

export const DeployProgressPayload = z.object({
  deployId: DeployId,
  stack: z.string().min(1).max(128),
  /** Swarm service name (`<stack>_<short>`), when the event is about one. */
  service: z.string().max(200).optional(),
  /** Hostname of the node the work happens on (the controller for its own stages). */
  node: z.string().max(253),
  stage: DeployStage,
  status: DeployEventStatus,
  /** Epoch ms when it happened. */
  at: Timestamp,
  /** One plain, display-safe line for the live log. */
  message: z.string().min(1).max(300),
  detail: DeployEventDetail.optional(),
});
export type DeployProgressPayload = z.infer<typeof DeployProgressPayload>;

export const DeployProgressMsg = z.object({
  type: z.literal('deployProgress'),
  payload: DeployProgressPayload,
});
export type DeployProgressMsg = z.infer<typeof DeployProgressMsg>;

/**
 * On `deployService`: "stream this service's progress into deploy X".
 * `role: 'main'` = the app people open (pull + start stages); `data` = a
 * companion that stores its data (reported under the data stage).
 */
export const DeployWatch = z.object({
  deployId: DeployId,
  stack: z.string().min(1).max(128),
  role: z.enum(['main', 'data']),
});
export type DeployWatch = z.infer<typeof DeployWatch>;
