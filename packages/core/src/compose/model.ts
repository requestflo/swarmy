import { z } from 'zod';

/**
 * Canonical, browser-safe service model — the single source of truth the GUI
 * builder, the compose translator, and the wire `ServiceSpec` are all
 * projections of. This file is PURE: no `node:*` imports, no I/O. Encodings are
 * always normalized (objects, never compose-style unions): ports are
 * `{ target, published, protocol, mode }`, env is `Record<string,string>`, etc.
 *
 * See plans/epic-stack-gui-builder.md — this is the Phase-1 "common fields"
 * coverage: image, replicas, env, ports, volumes, networks, command, labels,
 * restart, placement (constraints/preferences/maxReplicasPerNode).
 */

/** A normalized published/target port mapping. */
export const ModelPort = z.object({
  target: z.number().int().min(1).max(65535),
  published: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  mode: z.enum(['ingress', 'host']).default('ingress'),
});
export type ModelPort = z.infer<typeof ModelPort>;

/** A normalized mount (volume / bind / tmpfs). */
export const ModelMount = z.object({
  type: z.enum(['volume', 'bind', 'tmpfs']).default('volume'),
  source: z.string().optional(),
  target: z.string().min(1),
  readOnly: z.boolean().default(false),
});
export type ModelMount = z.infer<typeof ModelMount>;

/** Swarm restart policy (compose `deploy.restart_policy`). */
export const ModelRestartPolicy = z.object({
  condition: z.enum(['none', 'on-failure', 'any']).optional(),
  maxAttempts: z.number().int().nonnegative().optional(),
});
export type ModelRestartPolicy = z.infer<typeof ModelRestartPolicy>;

/**
 * Swarm scheduling (compose `deploy.placement`). Constraints/preferences are
 * the raw Swarm strings (`node.role==worker`, `node.labels.zone`).
 */
export const ModelPlacement = z.object({
  constraints: z.array(z.string()).default([]),
  preferences: z.array(z.string()).default([]),
  maxReplicasPerNode: z.number().int().positive().optional(),
});
export type ModelPlacement = z.infer<typeof ModelPlacement>;

const serviceName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, 'lowercase letters, digits, and _ . - only');

/**
 * The canonical service model. `mode` is `replicated` (with `replicas`) or
 * `global`. Everything optional has Swarm-default behavior when omitted, so an
 * untouched advanced section equals today's behavior.
 */
export const ServiceModel = z.object({
  name: serviceName,
  image: z.string().min(1),
  mode: z.enum(['replicated', 'global']).default('replicated'),
  replicas: z.number().int().min(0).max(1000).default(1),
  env: z.record(z.string()).default({}),
  command: z.array(z.string()).default([]),
  args: z.array(z.string()).default([]),
  ports: z.array(ModelPort).default([]),
  mounts: z.array(ModelMount).default([]),
  networks: z.array(z.string()).default([]),
  labels: z.record(z.string()).default({}),
  restart: ModelRestartPolicy.optional(),
  placement: ModelPlacement.optional(),
  /**
   * Compose keys swarmy doesn't model but preserves verbatim for round-trip
   * fidelity (re-emitted by modelToCompose). Never sent to the agent.
   */
  unsupported: z.record(z.unknown()).default({}),
});
export type ServiceModel = z.infer<typeof ServiceModel>;

/** Output type (after `.default()` application). */
export type ServiceModelOut = z.output<typeof ServiceModel>;
