import { z } from 'zod';
import { CommandId, Timestamp } from './primitives';

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

/** Registry credentials for pulling private images. */
export const RegistryAuth = z.object({
  username: z.string(),
  password: z.string(),
  server: z.string().optional(),
});
export type RegistryAuth = z.infer<typeof RegistryAuth>;

/**
 * Unopinionated near-raw Docker Swarm service spec subset. The controller
 * builds this; the agent translates it into dockerode `createService`/`update`.
 */
export const ServiceSpec = z.object({
  name: z.string(),
  image: z.string(),
  mode: z
    .object({
      replicated: z.object({ replicas: z.number().int().nonnegative() }).optional(),
      global: z.object({}).optional(),
    })
    .optional(),
  env: z.record(z.string()).optional(),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  labels: z.record(z.string()).optional(),
  ports: z
    .array(
      z.object({
        target: z.number().int(),
        published: z.number().int().optional(),
        protocol: z.enum(['tcp', 'udp']).default('tcp'),
        mode: z.enum(['ingress', 'host']).default('ingress'),
      }),
    )
    .optional(),
  mounts: z
    .array(
      z.object({
        type: z.enum(['volume', 'bind', 'tmpfs']),
        source: z.string().optional(),
        target: z.string(),
        readOnly: z.boolean().optional(),
      }),
    )
    .optional(),
  networks: z.array(z.string()).optional(),
  /**
   * Per-network DNS aliases, keyed by an entry of `networks` (by name — the
   * agent remaps the key when it resolves names → ids). Maps onto
   * `TaskTemplate.Networks[].Aliases`: a compose stack joins `<stack>_default`
   * with the SHORT service name (`db`) as an alias so `db:5432` resolves like
   * under `docker stack deploy`. Additive: when OMITTED on an update the agent
   * keeps the aliases the live service already carries (so a lossy rebuild —
   * an env/image/network patch — never silently breaks in-stack DNS); when
   * present it is authoritative.
   */
  networkAliases: z.record(z.array(z.string())).optional(),
  registryAuth: RegistryAuth.optional(),
  restartPolicy: z
    .object({
      condition: z.enum(['none', 'on-failure', 'any']).optional(),
      maxAttempts: z.number().int().optional(),
    })
    .optional(),
  /**
   * Rolling-update policy (Docker `UpdateConfig`). swarmy's system services
   * set it so an update never takes every task down at once: one task at a
   * time, rolled back if the new one fails. Omitted = Docker's defaults.
   */
  updateConfig: z
    .object({
      parallelism: z.number().int().nonnegative().optional(),
      order: z.enum(['stop-first', 'start-first']).optional(),
      failureAction: z.enum(['pause', 'continue', 'rollback']).optional(),
      monitorNs: z.number().int().nonnegative().optional(),
      delayNs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  placement: z
    .object({
      constraints: z.array(z.string()).optional(),
      preferences: z.array(z.string()).optional(),
      maxReplicasPerNode: z.number().int().positive().optional(),
    })
    .optional(),
  healthcheck: z
    .object({
      test: z.array(z.string()).optional(),
      intervalNs: z.number().int().nonnegative().optional(),
      timeoutNs: z.number().int().nonnegative().optional(),
      startPeriodNs: z.number().int().nonnegative().optional(),
      retries: z.number().int().nonnegative().optional(),
      disable: z.boolean().optional(),
    })
    .optional(),
  resources: z
    .object({
      limits: z
        .object({
          cpus: z.number().nonnegative().optional(),
          memoryBytes: z.number().int().nonnegative().optional(),
        })
        .optional(),
      reservations: z
        .object({
          cpus: z.number().nonnegative().optional(),
          memoryBytes: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
  configs: z
    .array(
      z.object({
        source: z.string(),
        target: z.string().optional(),
        uid: z.string().optional(),
        gid: z.string().optional(),
        mode: z.number().int().optional(),
      }),
    )
    .optional(),
  secrets: z
    .array(
      z.object({
        source: z.string(),
        target: z.string().optional(),
        uid: z.string().optional(),
        gid: z.string().optional(),
        mode: z.number().int().optional(),
      }),
    )
    .optional(),
  /**
   * Secret app variables delivered as ENV without their value ever entering
   * the spec: each name must be a `secrets` ref TARGET (`/run/secrets/<NAME>`).
   * The agent wraps the container in the secret-env shim at deploy time
   * (`wrapSecretEnv` in `@swarmy/core` app-secrets: `/bin/sh <shim> <original
   * argv>`, `SWARMY_SECRET_ENV=<names>`), which exports each file then execs
   * the app. Never carried to Docker as-is; `specFromInspect` reverses the
   * wrap. Additive — an agent that predates it ignores the field (use `file`
   * delivery there).
   */
  secretEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
  stopGracePeriodNs: z.number().int().nonnegative().optional(),
  /**
   * Container log driver (compose `logging`). OMITTED = swarmy's bounded
   * default (`json-file`, 10m × 3 — see `DEFAULT_LOG_DRIVER`) so no container
   * swarmy deploys can fill a node's disk with logs; on an update the live
   * service's driver is carried instead (`carryLogDriver`). Set it to override
   * (e.g. `{ driver: 'local' }`, a loki/fluentd driver, or bigger limits).
   */
  logging: z
    .object({ driver: z.string().min(1), options: z.record(z.string()).optional() })
    .optional(),
});
export type ServiceSpec = z.infer<typeof ServiceSpec>;

export const DeployServicePayload = z.object({
  ...cmd,
  spec: ServiceSpec,
  pullPolicy: z.enum(['always', 'missing', 'never']).default('missing'),
  /**
   * Pull credentials the swarm stores with the service (`X-Registry-Auth`, the
   * `docker stack deploy --with-registry-auth` equivalent) so EVERY node can
   * pull a private image. Attached centrally by the controller hub for
   * org-registry images; additive — older agents ignore it.
   */
  registryAuth: RegistryAuth.optional(),
});
export const DeployServiceMsg = z.object({
  type: z.literal('deployService'),
  payload: DeployServicePayload,
});
export type DeployServiceMsg = z.infer<typeof DeployServiceMsg>;

/**
 * Idempotently ensure an (attachable overlay) network exists BEFORE deploying a
 * service that attaches to it — fixes "network <x> not found" on a fresh overlay.
 * The agent resolves/creates via `docker.ensureNetwork`. Manager-only.
 */
export const EnsureNetworkPayload = z.object({
  ...cmd,
  name: z.string(),
  driver: z.string().default('overlay'),
  attachable: z.boolean().default(true),
  labels: z.record(z.string()).optional(),
  /**
   * Docker driver options applied at CREATE time only (an existing network is
   * never recreated): `com.docker.network.driver.mtu` when the data path rides
   * a WireGuard mesh, `encrypted` for IPsec. Optional — older agents ignore it
   * and inherit nothing; newer agents also inherit the platform overlay's MTU.
   */
  options: z.record(z.string()).optional(),
});
export const EnsureNetworkMsg = z.object({
  type: z.literal('ensureNetwork'),
  payload: EnsureNetworkPayload,
});
export type EnsureNetworkMsg = z.infer<typeof EnsureNetworkMsg>;

/**
 * Remove the overlay networks swarmy created for a compose stack
 * (`<stack>_default`, `<stack>_<net>`) once its services are gone. The agent
 * only ever removes networks labelled BOTH `com.docker.stack.namespace=<stack>`
 * and `swarmy.managed=true` (what `network.ensure` stamps for a compose deploy)
 * — never an external network, never the shared `swarmy` overlay. Retries while
 * the just-removed tasks still hold endpoints. Manager-only.
 */
export const RemoveStackNetworksPayload = z.object({
  ...cmd,
  stack: z.string().min(1),
});
export const RemoveStackNetworksMsg = z.object({
  type: z.literal('removeStackNetworks'),
  payload: RemoveStackNetworksPayload,
});
export type RemoveStackNetworksMsg = z.infer<typeof RemoveStackNetworksMsg>;

export const RemoveServicePayload = z.object({ ...cmd, service: z.string() });
export const RemoveServiceMsg = z.object({
  type: z.literal('removeService'),
  payload: RemoveServicePayload,
});
export type RemoveServiceMsg = z.infer<typeof RemoveServiceMsg>;

export const ScaleServicePayload = z.object({
  ...cmd,
  service: z.string(),
  replicas: z.number().int().nonnegative(),
});
export const ScaleServiceMsg = z.object({
  type: z.literal('scaleService'),
  payload: ScaleServicePayload,
});
export type ScaleServiceMsg = z.infer<typeof ScaleServiceMsg>;

/** Read the FULL raw `docker service inspect` for one service (details/debug view). */
export const InspectServicePayload = z.object({ ...cmd, service: z.string() });
export const InspectServiceMsg = z.object({
  type: z.literal('inspectService'),
  payload: InspectServicePayload,
});
export type InspectServiceMsg = z.infer<typeof InspectServiceMsg>;

/** Merge/remove labels on a live service — how swarmy persists config (Docker-truth). */
export const UpdateServiceLabelsPayload = z.object({
  ...cmd,
  service: z.string(),
  add: z.record(z.string()).default({}),
  removeKeys: z.array(z.string()).default([]),
});
export const UpdateServiceLabelsMsg = z.object({
  type: z.literal('updateServiceLabels'),
  payload: UpdateServiceLabelsPayload,
});
export type UpdateServiceLabelsMsg = z.infer<typeof UpdateServiceLabelsMsg>;

export const RestartServicePayload = z.object({
  ...cmd,
  service: z.string(),
  forceNewTask: z.boolean().default(true),
});
export const RestartServiceMsg = z.object({
  type: z.literal('restartService'),
  payload: RestartServicePayload,
});
export type RestartServiceMsg = z.infer<typeof RestartServiceMsg>;

export const PullImagePayload = z.object({
  ...cmd,
  image: z.string(),
  registryAuth: RegistryAuth.optional(),
  progress: z.boolean().default(false),
});
export const PullImageMsg = z.object({
  type: z.literal('pullImage'),
  payload: PullImagePayload,
});
export type PullImageMsg = z.infer<typeof PullImageMsg>;

/**
 * GATED: exec is default-on; the agent refuses when `SWARMY_ALLOW_EXEC=false`
 * or the controller asserts `nodeCapable: false` (`swarmy.node.exec=false`).
 * See `execGateAllows`. Audited controller-side.
 */
export const ExecCommandPayload = z.object({
  ...cmd,
  /** Controller's read of the node's exec label (see TermStartPayload.nodeCapable). */
  nodeCapable: z.boolean().optional(),
  target: z.object({ containerId: z.string() }),
  cmd: z.array(z.string()).nonempty(),
  tty: z.boolean().default(false),
  stream: z.boolean().default(true),
});
export const ExecCommandMsg = z.object({
  type: z.literal('execCommand'),
  payload: ExecCommandPayload,
});
export type ExecCommandMsg = z.infer<typeof ExecCommandMsg>;

export const StreamLogsPayload = z.object({
  commandId: CommandId,
  action: z.enum(['start', 'stop']),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('container'), containerId: z.string() }),
    z.object({ kind: z.literal('service'), service: z.string() }),
  ]),
  follow: z.boolean().default(true),
  tail: z.number().int().nonnegative().default(200),
  since: Timestamp.optional(),
  timestamps: z.boolean().default(true),
});
export const StreamLogsMsg = z.object({
  type: z.literal('streamLogs'),
  payload: StreamLogsPayload,
});
export type StreamLogsMsg = z.infer<typeof StreamLogsMsg>;

/** cordon / drain / set-labels / promote / demote a swarm node (manager only). */
export const UpdateSwarmNodePayload = z.object({
  ...cmd,
  swarmNodeId: z.string(),
  availability: z.enum(['active', 'pause', 'drain']).optional(),
  labels: z.record(z.string()).optional(),
  /** WS2 promote/demote — additive; the agent passes it through to `Spec.Role`. */
  role: z.enum(['manager', 'worker']).optional(),
  /**
   * `docker node rm --force` the node instead of updating it (manager-only).
   * Used to drop the stale entry a re-pinned node leaves behind after it
   * rejoined under a new id. Additive; the other fields are ignored with it.
   */
  remove: z.boolean().optional(),
});
export const UpdateSwarmNodeMsg = z.object({
  type: z.literal('updateSwarmNode'),
  payload: UpdateSwarmNodePayload,
});
export type UpdateSwarmNodeMsg = z.infer<typeof UpdateSwarmNodeMsg>;

export const UpdateAgentPayload = z.object({
  ...cmd,
  targetVersion: z.string(),
  /** Binary URL + pinned checksum — required by the self-replace strategy. */
  downloadUrl: z.string().url().optional(),
  sha256: z.string().length(64).optional(),
  strategy: z.enum(['self-replace', 'docker-recreate']).default('self-replace'),
  /** Container image ref — required by the docker-recreate strategy. */
  image: z.string().optional(),
});
export const UpdateAgentMsg = z.object({
  type: z.literal('updateAgent'),
  payload: UpdateAgentPayload,
});
export type UpdateAgentMsg = z.infer<typeof UpdateAgentMsg>;

export const PingPayload = z.object({ nonce: z.string() });
export const PingMsg = z.object({ type: z.literal('ping'), payload: PingPayload });
export type PingMsg = z.infer<typeof PingMsg>;
