import { z } from 'zod';
import { NodeId, Timestamp } from './primitives';

/** Facts the agent reports about its node at register time. */
export const NodeFacts = z.object({
  hostname: z.string().min(1),
  os: z.string(),
  arch: z.string(),
  cpuCount: z.number().int().positive(),
  cpuModel: z.string().optional(),
  memTotalBytes: z.number().int().nonnegative(),
  dockerVersion: z.string(),
  dockerApiVersion: z.string().optional(),
  swarmRole: z.enum(['manager', 'worker', 'none']),
  agentVersion: z.string(),
  /**
   * How this agent is installed: `binary` = compiled host binary (systemd),
   * `container` = interpreted under Bun (Docker-container backend / dev).
   * Drives the controller's updateAgent strategy (self-replace vs
   * docker-recreate). Optional: absent on agents predating self-update.
   */
  agentPackaging: z.enum(['binary', 'container']).optional(),
  /** Protocol versions this agent can speak (for negotiation). */
  protocolVersions: z.array(z.number().int()).nonempty(),
  /**
   * Self-detected public IPv4 (geo-edge: DNS answers are node public IPs).
   * The controller cross-checks against the connection source and stamps the
   * `swarmy.node.public-ip` node label; the override label wins.
   */
  publicIp: z.string().optional(),
});
export type NodeFacts = z.infer<typeof NodeFacts>;

/**
 * Two credential kinds: `join` bootstraps a brand-new node with a join token;
 * `session` re-auths an existing node on reconnect with its rotating secret.
 */
export const RegisterAuth = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('join'), joinToken: z.string() }),
  z.object({ kind: z.literal('session'), nodeId: NodeId, sessionSecret: z.string() }),
]);
export type RegisterAuth = z.infer<typeof RegisterAuth>;

export const RegisterPayload = z.object({ auth: RegisterAuth, facts: NodeFacts });
export type RegisterPayload = z.infer<typeof RegisterPayload>;

export const RegisterMsg = z.object({
  type: z.literal('register'),
  payload: RegisterPayload,
});
export type RegisterMsg = z.infer<typeof RegisterMsg>;

/** Returned by the controller on a successful register. */
export const RegisterAckPayload = z.object({
  nodeId: NodeId,
  /** Persisted by the agent (mode 0600) and used for all future reconnects. */
  sessionCredential: z.object({
    sessionSecret: z.string(),
    sessionVersion: z.number().int(),
  }),
  negotiatedVersion: z.number().int(),
  heartbeatIntervalMs: z.number().int(),
  metricsIntervalMs: z.number().int(),
  serverTime: Timestamp,
});
export type RegisterAckPayload = z.infer<typeof RegisterAckPayload>;

export const RegisterAckMsg = z.object({
  type: z.literal('registerAck'),
  payload: RegisterAckPayload,
});
export type RegisterAckMsg = z.infer<typeof RegisterAckMsg>;
