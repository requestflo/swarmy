import { z } from 'zod';

/**
 * Input schemas shared by the dashboard forms (react-hook-form resolver) and
 * the tRPC routers (`.input()`). One definition per concept — no drift.
 */

export const EnvVar = z.object({
  key: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE, starting with a letter or underscore'),
  value: z.string(),
});
export type EnvVar = z.infer<typeof EnvVar>;

export const PortMapping = z.object({
  target: z.number().int().min(1).max(65535),
  published: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  mode: z.enum(['ingress', 'host']).default('ingress'),
});
export type PortMapping = z.infer<typeof PortMapping>;

export const VolumeMount = z.object({
  type: z.enum(['volume', 'bind', 'tmpfs']).default('volume'),
  source: z.string().optional(),
  target: z.string().min(1),
  readOnly: z.boolean().default(false),
});
export type VolumeMount = z.infer<typeof VolumeMount>;

export const TlsMode = z.enum(['auto', 'off', 'custom']);
export type TlsMode = z.infer<typeof TlsMode>;

/** Per-service ingress fragment — creates/updates a Domain row. */
export const ServiceIngressInput = z.object({
  enabled: z.boolean().default(false),
  domain: z.string().optional(),
  targetPort: z.number().int().min(1).max(65535).optional(),
  tls: TlsMode.default('auto'),
  pathPrefix: z.string().optional(),
});
export type ServiceIngressInput = z.infer<typeof ServiceIngressInput>;

const serviceName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, 'lowercase letters, digits, and _ . - only');

export const CreateServiceInput = z.object({
  name: serviceName,
  image: z.string().min(1),
  replicas: z.number().int().min(0).max(1000).default(1),
  command: z.array(z.string()).default([]),
  env: z.array(EnvVar).default([]),
  ports: z.array(PortMapping).default([]),
  volumes: z.array(VolumeMount).default([]),
  networks: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  /** Pin to a single node; omit for swarm-wide scheduling. */
  nodeId: z.string().optional(),
  /** Project = Docker stack namespace; groups the service on the canvas. */
  project: z.string().optional(),
  ingress: ServiceIngressInput.optional(),
});
export type CreateServiceInput = z.infer<typeof CreateServiceInput>;

export const UpdateServiceInput = CreateServiceInput.partial().extend({
  id: z.string(),
});
export type UpdateServiceInput = z.infer<typeof UpdateServiceInput>;

export const LogsInput = z.object({
  serviceId: z.string().optional(),
  containerId: z.string().optional(),
  tail: z.number().int().min(0).max(5000).default(200),
  follow: z.boolean().default(true),
  since: z.number().int().optional(),
});
export type LogsInput = z.infer<typeof LogsInput>;

export const CursorInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type CursorInput = z.infer<typeof CursorInput>;

export const MetricKind = z.enum(['cpu', 'mem', 'net', 'disk']);
export type MetricKind = z.infer<typeof MetricKind>;

export const TimeRange = z.enum(['5m', '15m', '1h', '6h', '24h', '7d']);
export type TimeRange = z.infer<typeof TimeRange>;

export const TimeseriesInput = z.object({
  nodeId: z.string().optional(),
  serviceId: z.string().optional(),
  containerId: z.string().optional(),
  metric: MetricKind.default('cpu'),
  range: TimeRange.default('1h'),
});
export type TimeseriesInput = z.infer<typeof TimeseriesInput>;

// ── D1 releases: release history + health-gated deploys + rollback ──────────

export const ReleaseListInput = z.object({
  /** Restrict to one stack's history; omit for the org-wide recent feed. */
  stackName: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export type ReleaseListInput = z.infer<typeof ReleaseListInput>;

export const RollbackReleaseInput = z.object({
  releaseId: z.string().min(1),
  /** Override admission-policy violations (audited; block-level needs admin). */
  override: z.boolean().default(false),
});
export type RollbackReleaseInput = z.infer<typeof RollbackReleaseInput>;

export const SetDeploySafetyInput = z.object({
  stackName: z.string().min(1),
  /** false = remove the health gate (clears the `swarmy.deploy.safety` label). */
  enabled: z.boolean(),
  /** Watch window after a deploy before the release is judged, in seconds. */
  windowSec: z.number().int().min(30).max(3600).default(120),
  /** Redeploy the previous healthy release automatically when the gate fails. */
  autoRollback: z.boolean().default(false),
});
export type SetDeploySafetyInput = z.infer<typeof SetDeploySafetyInput>;

export const GetDeploySafetyInput = z.object({ stackName: z.string().min(1) });
export type GetDeploySafetyInput = z.infer<typeof GetDeploySafetyInput>;

// ── DB backups (slice A1) — schedule + run inputs shared by forms and routers ──
// The schedule is Docker truth: it is stored as the `swarmy.db.backup.schedule`
// JSON label on the managed cluster's primary service (shape mirrors
// `DbBackupScheduleInput`), never in a Prisma row.
import { DbBackupEngine as DbBackupEngineSchema } from './protocol/dbBackup';

/** 5-field cron expression (minute hour day-of-month month day-of-week, UTC). */
export const CronExpression = z
  .string()
  .trim()
  .regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, 'must be a 5-field cron expression');
export type CronExpression = z.infer<typeof CronExpression>;

/** The `swarmy.db.backup.schedule` label payload ({cron, engine, retentionDays, pitr}). */
export const DbBackupScheduleInput = z.object({
  cron: CronExpression,
  engine: DbBackupEngineSchema,
  retentionDays: z.number().int().min(1).max(3650).default(14),
  pitr: z.boolean().default(false),
  /** Backup destination (org BackupTarget id); defaults to the org's first enabled target. */
  targetId: z.string().min(1).optional(),
  /** Physical engines (wal-g / pgbackrest): the primary's PGDATA Docker volume. */
  dataVolume: z.string().min(1).optional(),
});
export type DbBackupScheduleInput = z.infer<typeof DbBackupScheduleInput>;

/** Enable (with a full schedule) or disable recurring backups for one cluster. */
export const SetDbBackupScheduleInput = z.discriminatedUnion('enabled', [
  z
    .object({
      enabled: z.literal(true),
      stack: z.string().min(1),
      cluster: z.string().min(1),
    })
    .extend(DbBackupScheduleInput.shape),
  z.object({
    enabled: z.literal(false),
    stack: z.string().min(1),
    cluster: z.string().min(1),
  }),
]);
export type SetDbBackupScheduleInput = z.infer<typeof SetDbBackupScheduleInput>;

/** One-off "back up now" — omitted fields default from the cluster's schedule label. */
export const RunDbBackupInput = z.object({
  stack: z.string().min(1),
  cluster: z.string().min(1),
  engine: DbBackupEngineSchema.optional(),
  targetId: z.string().min(1).optional(),
  database: z.string().min(1).optional(),
  dataVolume: z.string().min(1).optional(),
});
export type RunDbBackupInput = z.infer<typeof RunDbBackupInput>;

// ── Registry policy (platform buildout, D3) ──────────────────────────────────

/** Partial update of the org's registry admission policy toggles. */
export const SetRegistryPolicyInput = z.object({
  requireSignedImages: z.boolean().optional(),
  blockCriticalCves: z.boolean().optional(),
});
export type SetRegistryPolicyInput = z.infer<typeof SetRegistryPolicyInput>;

/** Re-run the CVE scan for one image ref (as pushed to the org registry). */
export const RescanImageInput = z.object({ imageRef: z.string().min(1) });
export type RescanImageInput = z.infer<typeof RescanImageInput>;

// ── Managed cache (slice A3) — wizard/router inputs (labels are Docker truth) ──
import { CACHE_ENGINES, CACHE_TOPOLOGIES } from './views';

export const CacheEngineInput = z.enum(CACHE_ENGINES);
export type CacheEngineInput = z.infer<typeof CacheEngineInput>;

export const CacheTopologyInput = z.enum(CACHE_TOPOLOGIES);
export type CacheTopologyInput = z.infer<typeof CacheTopologyInput>;

/** Per-region replica plan (`swarmy.cache.region.<region>.replicas`). */
export const CacheRegionPlanInput = z.object({
  region: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid region'),
  replicas: z.number().int().min(0).max(20),
});
export type CacheRegionPlanInput = z.infer<typeof CacheRegionPlanInput>;

/** Provision a managed Valkey/Redis cluster (create-cache wizard + router). */
export const ProvisionCacheInput = z.object({
  stack: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid stack name'),
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid cluster name'),
  engine: CacheEngineInput.default('valkey'),
  topology: CacheTopologyInput.default('single'),
  /** maxmemory in MB — also drives the swarm resource limit. */
  memoryMb: z.number().int().min(64).max(65536).default(256),
  /** Read replicas (sentinel topology needs at least 1 to fail over to). */
  replicas: z.number().int().min(0).max(10).default(0),
  regions: z.array(CacheRegionPlanInput).default([]),
  /** Optionally wire an app service right after provisioning. */
  attachService: z.string().min(1).optional(),
});
export type ProvisionCacheInput = z.infer<typeof ProvisionCacheInput>;

/** Wire an app service to a cluster (REDIS_URL + password Docker secret ref). */
export const AttachCacheInput = z.object({
  stack: z.string().min(1).max(63),
  cluster: z.string().min(1).max(40),
  appService: z.string().min(1),
  envVar: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid env var name')
    .default('REDIS_URL'),
});
export type AttachCacheInput = z.infer<typeof AttachCacheInput>;

// ── Object storage — Garage buckets (slice A4) ────────────────────────────────

/** S3 bucket naming: lowercase letters, digits, dots and dashes, 3–63 chars. */
export const BucketNameInput = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, 'lowercase letters, digits, dots and dashes only');
export type BucketNameInput = z.infer<typeof BucketNameInput>;

export const CreateBucketInput = z.object({ name: BucketNameInput });
export type CreateBucketInput = z.infer<typeof CreateBucketInput>;

export const DeleteBucketInput = z.object({ bucketId: z.string().min(1) });
export type DeleteBucketInput = z.infer<typeof DeleteBucketInput>;

/** Garage per-key bucket permission flags. */
export const BucketPermissionsInput = z.object({
  read: z.boolean().default(false),
  write: z.boolean().default(false),
  owner: z.boolean().default(false),
});
export type BucketPermissionsInput = z.infer<typeof BucketPermissionsInput>;

export const GrantKeyOnBucketInput = z.object({
  bucketId: z.string().min(1),
  accessKeyId: z.string().min(1),
  permissions: BucketPermissionsInput,
  /** `allow` grants the set flags; `deny` revokes them (Garage allow/deny API). */
  mode: z.enum(['allow', 'deny']).default('allow'),
});
export type GrantKeyOnBucketInput = z.infer<typeof GrantKeyOnBucketInput>;

export const SetBucketQuotaInput = z.object({
  bucketId: z.string().min(1),
  /** Max stored bytes; null = unlimited. */
  maxSizeBytes: z.number().int().positive().nullable(),
  /** Max object count; null = unlimited. */
  maxObjects: z.number().int().positive().nullable(),
});
export type SetBucketQuotaInput = z.infer<typeof SetBucketQuotaInput>;

export const SetBucketWebsiteInput = z.object({
  bucketId: z.string().min(1),
  enabled: z.boolean(),
  indexDocument: z.string().min(1).max(255).default('index.html'),
  errorDocument: z.string().min(1).max(255).optional(),
});
export type SetBucketWebsiteInput = z.infer<typeof SetBucketWebsiteInput>;

export const CreateBucketKeyInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dots, dashes, underscores'),
});
export type CreateBucketKeyInput = z.infer<typeof CreateBucketKeyInput>;

export const DeleteBucketKeyInput = z.object({ accessKeyId: z.string().min(1) });
export type DeleteBucketKeyInput = z.infer<typeof DeleteBucketKeyInput>;

/** Wire an app service to a bucket (scoped key + S3_* env + secret). */
export const AttachBucketInput = z.object({
  bucketId: z.string().min(1),
  /** App service id or name (resolved against the live inventory). */
  appService: z.string().min(1),
});
export type AttachBucketInput = z.infer<typeof AttachBucketInput>;

export const DetachBucketInput = z.object({ appService: z.string().min(1) });
export type DetachBucketInput = z.infer<typeof DetachBucketInput>;

// ── Queues (slice B1) — defs live in the `swarmy.queues` label on the worker ──
import { QUEUE_CONVENTIONS } from './views';

export const QueueConventionInput = z.enum(QUEUE_CONVENTIONS);
export type QueueConventionInput = z.infer<typeof QueueConventionInput>;

/** Redis-key-safe fragment — these ride inside a shell-exec'd redis-cli call. */
const redisKeyName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/, 'letters, digits and : . _ - only');

/** Scale/behaviour rules shared by the attach wizard and the rule editor. */
export const QueueRuleFields = z.object({
  /** Autoscale slope: one worker replica per this many waiting jobs. */
  scalePerJobs: z.number().int().min(1).max(100000).default(100),
  minWorkers: z.number().int().min(0).max(100).default(1),
  maxWorkers: z.number().int().min(1).max(100).default(5),
  retries: z.number().int().min(0).max(100).default(3),
  dlq: z.boolean().default(true),
});
export type QueueRuleFields = z.infer<typeof QueueRuleFields>;

/** Attach a queue to a worker service (writes the `swarmy.queues` label). */
export const AttachQueueInput = z
  .object({
    /** Worker service (Docker id or name) that consumes the queue. */
    workerService: z.string().min(1),
    name: redisKeyName,
    /** `<cluster>` (same stack as the worker) or `<stack>/<cluster>`. */
    cacheCluster: z
      .string()
      .min(1)
      .max(120)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9-]*)?$/,
        'use <cluster> or <stack>/<cluster>',
      ),
    convention: QueueConventionInput.default('bullmq'),
    /** Raw list key (convention `list`; defaults to the queue name). */
    listKey: redisKeyName.optional(),
  })
  .extend(QueueRuleFields.shape);
export type AttachQueueInput = z.infer<typeof AttachQueueInput>;

/** Update an existing queue def (matched by `name` on the worker service). */
export const UpdateQueueInput = AttachQueueInput;
export type UpdateQueueInput = z.infer<typeof UpdateQueueInput>;

/** Address one queue on one worker service. */
export const QueueRefInput = z.object({
  workerService: z.string().min(1),
  queue: z.string().min(1).max(128),
});
export type QueueRefInput = z.infer<typeof QueueRefInput>;

/** Bounded batch size for retry-failed / DLQ-requeue actions. */
export const QueueBatchInput = QueueRefInput.extend({
  limit: z.number().int().min(1).max(1000).default(100),
});
export type QueueBatchInput = z.infer<typeof QueueBatchInput>;

export const QueueDlqListInput = QueueRefInput.extend({
  limit: z.number().int().min(1).max(200).default(50),
});
export type QueueDlqListInput = z.infer<typeof QueueDlqListInput>;

// ── Scheduled jobs (slice B2) ─────────────────────────────────────────────────
import { JOB_KINDS } from './views';

export const JobKindInput = z.enum(JOB_KINDS);
export type JobKindInput = z.infer<typeof JobKindInput>;

/** Raw 5-field cron expression — parsed/validated server-side (UTC). */
export const CronScheduleInput = z.string().trim().min(1).max(100);
export type CronScheduleInput = z.infer<typeof CronScheduleInput>;

/** Placement constraints for `image` jobs (`ScheduledJob.runOnJson`). */
export const JobRunOnInput = z.object({
  /** Pin to one node (controller node id or name). */
  nodeId: z.string().min(1).optional(),
  /** Require these swarm node labels (all must match). */
  labels: z.record(z.string()).optional(),
});
export type JobRunOnInput = z.infer<typeof JobRunOnInput>;

export const CreateScheduledJobInput = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
  schedule: CronScheduleInput,
  kind: JobKindInput.default('image'),
  /** Required when kind = image. */
  image: z.string().min(1).max(255).optional(),
  /** Service (Docker id or name) to exec into — required when kind = service-exec. */
  serviceRef: z.string().min(1).max(255).optional(),
  command: z.array(z.string().max(4096)).max(64).default([]),
  env: z.record(z.string().max(8192)).default({}),
  runOn: JobRunOnInput.default({}),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).default(600_000),
  retries: z.number().int().min(0).max(5).default(0),
  alertOnFailure: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type CreateScheduledJobInput = z.infer<typeof CreateScheduledJobInput>;

export const UpdateScheduledJobInput = CreateScheduledJobInput.partial().extend({
  id: z.string().min(1),
});
export type UpdateScheduledJobInput = z.infer<typeof UpdateScheduledJobInput>;

export const JobRunsInput = z.object({
  jobId: z.string().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type JobRunsInput = z.infer<typeof JobRunsInput>;

export const PreviewScheduleInput = z.object({
  schedule: CronScheduleInput,
  count: z.number().int().min(1).max(10).default(3),
});
export type PreviewScheduleInput = z.infer<typeof PreviewScheduleInput>;

// ── Workflows (slice B3) ──────────────────────────────────────────────────────
import { WORKFLOW_STEP_KINDS } from './views';

export const WorkflowStepKindInput = z.enum(WORKFLOW_STEP_KINDS);
export type WorkflowStepKindInput = z.infer<typeof WorkflowStepKindInput>;

const workflowName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only');

/**
 * Per-step config as SUBMITTED by the builder. Which fields matter depends on
 * the step kind (validated server-side); `secret` is plaintext on the wire
 * only — it is vault-encrypted before persisting and never returned.
 */
export const WorkflowStepConfigInput = z.object({
  image: z.string().min(1).max(255).optional(),
  command: z.array(z.string().max(4096)).max(64).optional(),
  env: z.record(z.string().max(8192)).optional(),
  serviceRef: z.string().min(1).max(255).optional(),
  url: z.string().min(1).max(2048).optional(),
  /** webhook HMAC secret; omit on edit to keep the stored one. */
  secret: z.string().max(512).optional(),
  prompt: z.string().max(2000).optional(),
  seconds: z.number().int().min(1).max(2_592_000).optional(),
});
export type WorkflowStepConfigInput = z.infer<typeof WorkflowStepConfigInput>;

export const WorkflowStepInput = z.object({
  name: workflowName,
  kind: WorkflowStepKindInput,
  config: WorkflowStepConfigInput.default({}),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
  retries: z.number().int().min(0).max(5).optional(),
});
export type WorkflowStepInput = z.infer<typeof WorkflowStepInput>;

export const CreateWorkflowDefInput = z.object({
  name: workflowName,
  steps: z.array(WorkflowStepInput).min(1).max(30),
  enabled: z.boolean().default(true),
});
export type CreateWorkflowDefInput = z.infer<typeof CreateWorkflowDefInput>;

/** Edits never mutate history: an update creates version n+1 for the name. */
export const UpdateWorkflowDefInput = z.object({
  name: workflowName,
  steps: z.array(WorkflowStepInput).min(1).max(30),
  enabled: z.boolean().optional(),
});
export type UpdateWorkflowDefInput = z.infer<typeof UpdateWorkflowDefInput>;

export const WorkflowDefRefInput = z.object({ name: workflowName });
export type WorkflowDefRefInput = z.infer<typeof WorkflowDefRefInput>;

/** Trigger by def id (exact version) or by name (latest version). */
export const TriggerWorkflowInput = z
  .object({
    defId: z.string().min(1).optional(),
    name: workflowName.optional(),
    /** Optional JSON payload for the run (parsed server-side; raw string ok). */
    inputJson: z.string().max(65_536).optional(),
  })
  .refine((v) => Boolean(v.defId || v.name), { message: 'defId or name required' });
export type TriggerWorkflowInput = z.infer<typeof TriggerWorkflowInput>;

export const WorkflowRunsInput = z.object({
  /** Restrict to one definition's runs (any version of the name). */
  defName: workflowName.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type WorkflowRunsInput = z.infer<typeof WorkflowRunsInput>;

export const WorkflowRunRefInput = z.object({ runId: z.string().min(1) });
export type WorkflowRunRefInput = z.infer<typeof WorkflowRunRefInput>;

/** Approve/reject the waiting approval step (note lands in the step output). */
export const WorkflowDecisionInput = z.object({
  runId: z.string().min(1),
  note: z.string().max(2_000).optional(),
});
export type WorkflowDecisionInput = z.infer<typeof WorkflowDecisionInput>;

// ── Inbound webhook gateway (slice B4) ────────────────────────────────────────
// (QUEUE_CONVENTIONS is already imported above — slice B1's block.)
import { INBOUND_DELIVERY_STATUSES, INBOUND_VERIFY_KINDS } from './views';

export const InboundVerifyKindInput = z.enum(INBOUND_VERIFY_KINDS);
export type InboundVerifyKindInput = z.infer<typeof InboundVerifyKindInput>;

const inboundSlug = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only');

/** Where verified deliveries go — a queue on a managed cache, or a POST. */
export const InboundTargetInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('queue'),
    /** `<cluster>` (searched across stacks) or `<stack>/<cluster>`. */
    cacheCluster: z.string().min(1).max(128),
    queue: z.string().min(1).max(128),
    convention: z.enum(QUEUE_CONVENTIONS).default('list'),
  }),
  z.object({
    kind: z.literal('forward'),
    /** Controller-reachable http(s) URL — the controller cannot reach overlay networks. */
    url: z.string().url().max(2048),
  }),
]);
export type InboundTargetInput = z.infer<typeof InboundTargetInput>;

export const CreateInboundEndpointInput = z.object({
  name: z.string().min(1).max(120),
  slug: inboundSlug,
  verifyKind: InboundVerifyKindInput.default('none'),
  /** Shared verify secret (plaintext on the wire once; vault-encrypted at rest). */
  secret: z.string().min(8).max(512).optional(),
  target: InboundTargetInput,
  retentionDays: z.number().int().min(1).max(365).default(30),
});
export type CreateInboundEndpointInput = z.infer<typeof CreateInboundEndpointInput>;

/** Slug is immutable (it is the public URL); omit `secret` to keep the stored one. */
export const UpdateInboundEndpointInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  verifyKind: InboundVerifyKindInput.optional(),
  secret: z.string().min(8).max(512).optional(),
  target: InboundTargetInput.optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
});
export type UpdateInboundEndpointInput = z.infer<typeof UpdateInboundEndpointInput>;

export const InboundDeliveriesInput = z.object({
  endpointId: z.string().min(1).optional(),
  status: z.enum(INBOUND_DELIVERY_STATUSES).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type InboundDeliveriesInput = z.infer<typeof InboundDeliveriesInput>;

export const InboundDeliveryRefInput = z.object({ id: z.string().min(1) });
export type InboundDeliveryRefInput = z.infer<typeof InboundDeliveryRefInput>;

export const InboundEndpointRefInput = z.object({ id: z.string().min(1) });
export type InboundEndpointRefInput = z.infer<typeof InboundEndpointRefInput>;

// ── Observability logs (slice C1) ─────────────────────────────────────────────

/**
 * Query input for the `observability.logs` procedure (ClickHouse `otel_logs`).
 * `from`/`to` are unix-epoch **milliseconds** (a closed time window); `cursor`
 * is the `ts_nano` of the last row of the previous page (descending timestamp
 * cursor — digits only so it can be inlined into SQL safely).
 */
export const ObservabilityLogsInput = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  /** Only lines from services labelled with this stack (`swarmy.stack`). */
  stack: z.string().min(1).max(255).optional(),
  serviceName: z.string().min(1).max(255).optional(),
  /** OTel severity-number floor (TRACE=1 … FATAL=21+); rows below are dropped. */
  severityMin: z.number().int().min(1).max(24).optional(),
  /** Case-insensitive substring match on the log body. */
  search: z.string().min(1).max(512).optional(),
  /** Only lines correlated to this trace. */
  traceId: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().regex(/^\d{1,20}$/).optional(),
});
export type ObservabilityLogsInput = z.infer<typeof ObservabilityLogsInput>;

// ── Service map + health narrative (slice C2) ─────────────────────────────────

/** Query input for `observability.map` (service graph from `otel_traces`). */
export const ObservabilityMapInput = z.object({
  /** Lookback window (default 15 minutes). */
  windowMinutes: z.number().int().min(1).max(1440).optional(),
});
export type ObservabilityMapInput = z.infer<typeof ObservabilityMapInput>;

/** Query input for `observability.health` (degraded-reason narrative). */
export const ObservabilityHealthInput = z.object({
  /** Scope the narrative to one stack; omit for the whole estate. */
  stack: z.string().min(1).max(255).optional(),
});
export type ObservabilityHealthInput = z.infer<typeof ObservabilityHealthInput>;

// ── Alerts (slice C3) — channels CRUD, rules CRUD, event feed ─────────────────
import { ALERT_EVENT_STATUSES, ALERT_SIGNALS } from './views';

/**
 * Channel destination config. Travels plaintext ONCE on create/update and is
 * vault-encrypted at rest (`configEnc`); it is never returned to clients.
 */
export const ChannelConfigInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), to: z.string().email().max(320) }),
  z.object({ kind: z.literal('slack'), url: z.string().url().max(1024) }),
  z.object({ kind: z.literal('teams'), url: z.string().url().max(1024) }),
  z.object({
    kind: z.literal('webhook'),
    url: z.string().url().max(1024),
    /** Optional HMAC secret — deliveries carry `X-Swarmy-Signature` when set. */
    secret: z.string().min(8).max(256).optional(),
  }),
]);
export type ChannelConfigInput = z.infer<typeof ChannelConfigInput>;

export const CreateChannelInput = z.object({
  name: z.string().min(1).max(120),
  config: ChannelConfigInput,
});
export type CreateChannelInput = z.infer<typeof CreateChannelInput>;

/** Omit `config` to keep the stored destination unchanged. */
export const UpdateChannelInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  config: ChannelConfigInput.optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelInput>;

export const ChannelRefInput = z.object({ id: z.string().min(1) });
export type ChannelRefInput = z.infer<typeof ChannelRefInput>;

export const CreateAlertRuleInput = z.object({
  name: z.string().min(1).max(120),
  signal: z.enum(ALERT_SIGNALS),
  threshold: z.number().finite().nullable().optional(),
  forSeconds: z.number().int().min(0).max(86_400).default(0),
  channelIds: z.array(z.string().min(1)).max(50).default([]),
  enabled: z.boolean().default(true),
});
export type CreateAlertRuleInput = z.infer<typeof CreateAlertRuleInput>;

export const UpdateAlertRuleInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  threshold: z.number().finite().nullable().optional(),
  forSeconds: z.number().int().min(0).max(86_400).optional(),
  channelIds: z.array(z.string().min(1)).max(50).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateAlertRuleInput = z.infer<typeof UpdateAlertRuleInput>;

export const AlertRuleRefInput = z.object({ id: z.string().min(1) });
export type AlertRuleRefInput = z.infer<typeof AlertRuleRefInput>;

export const AlertEventsInput = z.object({
  status: z.enum(ALERT_EVENT_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type AlertEventsInput = z.infer<typeof AlertEventsInput>;

export const AckAlertEventInput = z.object({ id: z.string().min(1) });
export type AckAlertEventInput = z.infer<typeof AckAlertEventInput>;

// ── Incidents (slice C4) — list/detail, notes, resolve/reopen ─────────────────
import { INCIDENT_STATUSES } from './views';

export const IncidentsListInput = z.object({
  /** Omit for every incident (open first); or filter to one status. */
  status: z.enum(INCIDENT_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type IncidentsListInput = z.infer<typeof IncidentsListInput>;

export const IncidentRefInput = z.object({ id: z.string().min(1) });
export type IncidentRefInput = z.infer<typeof IncidentRefInput>;

export const IncidentNoteInput = z.object({
  id: z.string().min(1),
  message: z.string().min(1).max(4_000),
});
export type IncidentNoteInput = z.infer<typeof IncidentNoteInput>;

export const ResolveIncidentInput = z.object({
  id: z.string().min(1),
  /** Optional resolution message for the final timeline event. */
  message: z.string().max(4_000).optional(),
});
export type ResolveIncidentInput = z.infer<typeof ResolveIncidentInput>;

// ── Status pages (slice C5) — CRUD + public snapshot ──────────────────────────
import { STATUS_PAGE_COMPONENT_KINDS } from './views';

/** Global-unique kebab slug — it becomes the public URL `/s/<slug>`. */
export const StatusPageSlug = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case: lowercase letters, digits and single dashes');
export type StatusPageSlug = z.infer<typeof StatusPageSlug>;

export const StatusPageComponentInput = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case key'),
  label: z.string().min(1).max(120),
  kind: z.enum(STATUS_PAGE_COMPONENT_KINDS),
  ref: z.string().min(1).max(200),
});
export type StatusPageComponentInput = z.infer<typeof StatusPageComponentInput>;

// Lookbehind-free (this schema ships in the browser bundle): each label starts
// and ends alphanumeric, dashes only in the middle, two+ labels required.
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const StatusPageDomain = z
  .string()
  .min(3)
  .max(253)
  .regex(
    new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`),
    'a bare hostname, e.g. status.example.com',
  );

export const CreateStatusPageInput = z.object({
  title: z.string().min(1).max(120),
  slug: StatusPageSlug,
  domain: StatusPageDomain.optional(),
  components: z.array(StatusPageComponentInput).max(50).default([]),
  showUptime: z.boolean().default(true),
  showIncidents: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type CreateStatusPageInput = z.infer<typeof CreateStatusPageInput>;

export const UpdateStatusPageInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
  slug: StatusPageSlug.optional(),
  /** `null` clears the custom domain. */
  domain: StatusPageDomain.nullable().optional(),
  components: z.array(StatusPageComponentInput).max(50).optional(),
  showUptime: z.boolean().optional(),
  showIncidents: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateStatusPageInput = z.infer<typeof UpdateStatusPageInput>;

export const StatusPageRefInput = z.object({ id: z.string().min(1) });
export type StatusPageRefInput = z.infer<typeof StatusPageRefInput>;

export const SetStatusPageEnabledInput = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});
export type SetStatusPageEnabledInput = z.infer<typeof SetStatusPageEnabledInput>;

export const PublicStatusInput = z.object({ slug: StatusPageSlug });
export type PublicStatusInput = z.infer<typeof PublicStatusInput>;

// ── Secrets manager (slice E1) — families, rotation, attach/detach ────────────

/**
 * Family name: env-style, Docker-secret-name safe, and short enough that the
 * physical `<family>__v<n>` stays under Docker's 64-char cap. Names ending in
 * `__v<digits>` are refused so physical names always parse unambiguously.
 */
export const SecretFamilyName = z
  .string()
  .min(1)
  .max(56)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'letters, digits, dot, dash and underscore only')
  .refine((v) => !/__v\d+$/.test(v), { message: 'name must not end in __v<number>' });

/** Secret value — write-only: accepted here, never stored or returned. */
const SecretValue = z.string().min(1).max(100_000);

export const CreateSecretFamilyInput = z.object({
  family: SecretFamilyName,
  value: SecretValue,
});
export type CreateSecretFamilyInput = z.infer<typeof CreateSecretFamilyInput>;

export const RotateSecretInput = z.object({
  family: SecretFamilyName,
  value: SecretValue,
});
export type RotateSecretInput = z.infer<typeof RotateSecretInput>;

export const AttachSecretInput = z.object({
  family: SecretFamilyName,
  /** Live service id or name. */
  service: z.string().min(1).max(255),
  /** Optional env var set to the `/run/secrets/<family>` mount path. */
  envName: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid env var name')
    .max(120)
    .optional(),
});
export type AttachSecretInput = z.infer<typeof AttachSecretInput>;

export const DetachSecretInput = z.object({
  family: SecretFamilyName,
  service: z.string().min(1).max(255),
});
export type DetachSecretInput = z.infer<typeof DetachSecretInput>;

export const SecretFamilyRefInput = z.object({ family: SecretFamilyName });
export type SecretFamilyRefInput = z.infer<typeof SecretFamilyRefInput>;

// ── Configs manager (slice E2) — families, versions, apply/rollback ───────────

/**
 * Config family name — same codec constraints as secret families (physical
 * Docker configs are named `<family>__v<n>`, so names ending in `__v<digits>`
 * are refused and the length leaves room for the version suffix).
 */
export const ConfigFamilyName = SecretFamilyName;
export type ConfigFamilyName = z.infer<typeof ConfigFamilyName>;

/** Config content — readable (unlike secrets), capped under Docker's 500KB. */
const ConfigContent = z.string().min(1).max(256_000);

/** Absolute in-container mount path, e.g. `/etc/caddy/snippets/common.caddy`. */
export const ConfigMountPath = z
  .string()
  .min(2)
  .max(255)
  .regex(/^\/[A-Za-z0-9._/-]+$/, 'absolute path using letters, digits, dot, dash, underscore')
  .refine((v) => !v.includes('//') && !v.split('/').includes('..'), {
    message: 'no // or .. segments',
  })
  .refine((v) => !v.endsWith('/'), { message: 'must not end with /' });
export type ConfigMountPath = z.infer<typeof ConfigMountPath>;

export const CreateConfigFamilyInput = z.object({
  family: ConfigFamilyName,
  content: ConfigContent,
  /** Defaults to `/<family>` (Docker's own convention) when omitted. */
  mountPath: ConfigMountPath.optional(),
});
export type CreateConfigFamilyInput = z.infer<typeof CreateConfigFamilyInput>;

export const NewConfigVersionInput = z.object({
  family: ConfigFamilyName,
  content: ConfigContent,
});
export type NewConfigVersionInput = z.infer<typeof NewConfigVersionInput>;

export const ApplyConfigVersionInput = z.object({
  family: ConfigFamilyName,
  /** The version to move every consumer onto (older than current = rollback). */
  version: z.number().int().min(1),
});
export type ApplyConfigVersionInput = z.infer<typeof ApplyConfigVersionInput>;

export const GetConfigContentInput = z.object({
  family: ConfigFamilyName,
  /** Defaults to the family's current (newest) version. */
  version: z.number().int().min(1).optional(),
});
export type GetConfigContentInput = z.infer<typeof GetConfigContentInput>;

export const ConfigRestartPreviewInput = z.object({
  family: ConfigFamilyName,
  /** The apply target being previewed (defaults to current). */
  version: z.number().int().min(1).optional(),
});
export type ConfigRestartPreviewInput = z.infer<typeof ConfigRestartPreviewInput>;

export const AttachConfigInput = z.object({
  family: ConfigFamilyName,
  /** Live service id or name. */
  service: z.string().min(1).max(255),
});
export type AttachConfigInput = z.infer<typeof AttachConfigInput>;

export const DetachConfigInput = z.object({
  family: ConfigFamilyName,
  service: z.string().min(1).max(255),
});
export type DetachConfigInput = z.infer<typeof DetachConfigInput>;

export const ConfigFamilyRefInput = z.object({ family: ConfigFamilyName });
export type ConfigFamilyRefInput = z.infer<typeof ConfigFamilyRefInput>;

// ── Exposure (slice E3) — rules editor ────────────────────────────────────────

/** Partial update of the org's exposure rules; omitted fields keep their value. */
export const SetExposureRulesInput = z.object({
  noPublicPortsOnManagedData: z.boolean().optional(),
  noPublicUdp: z.boolean().optional(),
  warnOnNewPublishedPorts: z.boolean().optional(),
  /** "Block violating deploys" master switch. */
  enforce: z.boolean().optional(),
});
export type SetExposureRulesInput = z.infer<typeof SetExposureRulesInput>;

// ── Guardrails (slice E4) — production safety config ──────────────────────────

/** Guardrail rule ids — mirror `GUARDRAIL_RULE_IDS` in views.ts (kept literal for zod). */
export const GuardrailRuleIdInput = z.enum([
  'noLatestTagInProd',
  'minDbReplicasProd',
  'requireBackupPolicy',
  'requireHealthcheck',
  'requireResourceLimits',
  'requireSignedImagesProd',
  'noPrivilegedContainers',
  'noHostPortsProd',
]);
export type GuardrailRuleIdInput = z.infer<typeof GuardrailRuleIdInput>;

/** Flip the production-safety master switch. */
export const SetGuardrailSafetyModeInput = z.object({ enabled: z.boolean() });
export type SetGuardrailSafetyModeInput = z.infer<typeof SetGuardrailSafetyModeInput>;

/** Partial per-rule update; omitted fields keep their configured value. */
export const SetGuardrailRuleInput = z.object({
  id: GuardrailRuleIdInput,
  enabled: z.boolean().optional(),
  severity: z.enum(['block', 'warn']).optional(),
  /** Numeric params (e.g. `{ n: 2 }` for minDbReplicasProd). */
  params: z.record(z.number().int().min(0).max(1000)).optional(),
});
export type SetGuardrailRuleInput = z.infer<typeof SetGuardrailRuleInput>;

/** Mark/unmark a stack as production (`swarmy.env=production` on its services). */
export const SetStackEnvInput = z.object({
  stack: z.string().min(1).max(255),
  production: z.boolean(),
});
export type SetStackEnvInput = z.infer<typeof SetStackEnvInput>;

/** Recent blocked/overridden admission decisions feed. */
export const GuardrailDecisionsInput = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});
export type GuardrailDecisionsInput = z.infer<typeof GuardrailDecisionsInput>;

// ── Audit pack (slice E5) — query / export / retention ───────────────────────

/** Who performed an audited action (mirrors audit.service.ts AuditActorType). */
export const AuditActorTypeInput = z.enum(['user', 'apikey', 'system', 'agent']);
export type AuditActorTypeInput = z.infer<typeof AuditActorTypeInput>;

/** ISO date/datetime string — validated leniently so `<input type=date>` values pass. */
const AuditDateString = z
  .string()
  .min(4)
  .max(64)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'not a parseable date' });

/** Shared audit-log filters (list + export). `action` is a PREFIX match. */
export const AuditFilterInput = z.object({
  /** Exact actor id (user id / api key id / agent node id). */
  actor: z.string().min(1).max(255).optional(),
  actorType: AuditActorTypeInput.optional(),
  /** Action prefix, e.g. `secrets.` matches every secret mutation. */
  action: z.string().min(1).max(255).optional(),
  /** OR-of-prefixes used by canned questions ("who accessed production?"). */
  actions: z.array(z.string().min(1).max(255)).max(16).optional(),
  resourceType: z.string().min(1).max(255).optional(),
  resourceId: z.string().min(1).max(255).optional(),
  from: AuditDateString.optional(),
  to: AuditDateString.optional(),
});
export type AuditFilterInput = z.infer<typeof AuditFilterInput>;

export const AuditQueryInput = AuditFilterInput.extend({
  /** Opaque cursor: the numeric id of the last row of the previous page. */
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type AuditQueryInput = z.infer<typeof AuditQueryInput>;

export const AuditExportInput = AuditFilterInput.extend({
  format: z.enum(['csv', 'json']).default('csv'),
});
export type AuditExportInput = z.infer<typeof AuditExportInput>;

export const SetAuditRetentionInput = z.object({
  /** How long audit rows are kept before the retention worker prunes them. */
  days: z.number().int().min(7).max(3650),
});
export type SetAuditRetentionInput = z.infer<typeof SetAuditRetentionInput>;

// ── Cost & capacity (slice F1) — node monthly price label ─────────────────────

/** Set (or clear with null) a node's monthly price — the `swarmy.node.cost` label. */
export const SetNodeCostInput = z.object({
  nodeId: z.string().min(1),
  /** Monthly price in USD; null clears the label. */
  monthlyUsd: z.number().min(0).max(1_000_000).nullable(),
});
export type SetNodeCostInput = z.infer<typeof SetNodeCostInput>;

// ── Resilience (slice F2) — safe drills ───────────────────────────────────────

/** Restore drill: clone the latest DB backup into a throwaway cluster and verify. */
export const ResilienceRestoreDrillInput = z.object({
  stack: z.string().min(1).max(63),
  cluster: z.string().min(1).max(63),
});
export type ResilienceRestoreDrillInput = z.infer<typeof ResilienceRestoreDrillInput>;

/** Failover drill: promote a standby and verify — needs explicit acknowledgement. */
export const ResilienceFailoverDrillInput = z.object({
  stack: z.string().min(1).max(63),
  cluster: z.string().min(1).max(63),
  /** "I understand" — promotion briefly detaches a replica from the chain. */
  acknowledge: z.literal(true),
});
export type ResilienceFailoverDrillInput = z.infer<typeof ResilienceFailoverDrillInput>;

/** Backup-verify drill: `restic check` against a backup destination. */
export const ResilienceBackupVerifyInput = z.object({
  /** Backup target id; defaults to the org's first enabled destination. */
  targetId: z.string().min(1).optional(),
});
export type ResilienceBackupVerifyInput = z.infer<typeof ResilienceBackupVerifyInput>;

/** Drill-history page size. */
export const ResilienceDrillHistoryInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
});
export type ResilienceDrillHistoryInput = z.infer<typeof ResilienceDrillHistoryInput>;

// ── Blueprints (slice F3) — gallery params (name, domain?, size, options) ─────
import { BLUEPRINT_IDS, BLUEPRINT_SIZES } from './views';

export const BlueprintIdInput = z.enum(BLUEPRINT_IDS);
export type BlueprintIdInput = z.infer<typeof BlueprintIdInput>;

export const BlueprintSizeInput = z.enum(BLUEPRINT_SIZES);
export type BlueprintSizeInput = z.infer<typeof BlueprintSizeInput>;

/** `blog.example.com` — a routable hostname (no scheme, no path). */
const BlueprintDomain = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    'must be a hostname like blog.example.com',
  );

/**
 * Shared wizard params. `name` becomes the stack name and the prefix of every
 * created resource; `options` carries the catalog-declared per-blueprint knobs
 * (unknown keys are ignored by the generators).
 */
export const BlueprintParamsInput = z.object({
  name: z
    .string()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  domain: BlueprintDomain.optional(),
  size: BlueprintSizeInput.default('m'),
  options: z.record(z.union([z.string().max(500), z.boolean()])).default({}),
});
export type BlueprintParamsInput = z.infer<typeof BlueprintParamsInput>;

export const BlueprintPlanInput = z.object({
  id: BlueprintIdInput,
  params: BlueprintParamsInput,
});
export type BlueprintPlanInput = z.infer<typeof BlueprintPlanInput>;

export const BlueprintDeployInput = BlueprintPlanInput;
export type BlueprintDeployInput = z.infer<typeof BlueprintDeployInput>;

// ── Managed search (slice F4) — wizard/router inputs (labels are Docker truth) ──
import { SEARCH_ENGINES } from './views';

export const SearchEngineInput = z.enum(SEARCH_ENGINES);
export type SearchEngineInput = z.infer<typeof SearchEngineInput>;

/** Provision a managed Meilisearch/Typesense instance (create wizard + router). */
export const ProvisionSearchInput = z.object({
  stack: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid stack name'),
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid instance name'),
  engine: SearchEngineInput.default('meilisearch'),
  /** Optionally wire an app service right after provisioning. */
  attachService: z.string().min(1).optional(),
});
export type ProvisionSearchInput = z.infer<typeof ProvisionSearchInput>;

/** Wire an app service to an instance (host env vars + key Docker secret ref). */
export const AttachSearchInput = z.object({
  stack: z.string().min(1).max(63),
  name: z.string().min(1).max(40),
  appService: z.string().min(1),
});
export type AttachSearchInput = z.infer<typeof AttachSearchInput>;

// ── AI gateway (slice F5) — providers, virtual keys, usage, settings ──────────
import { AI_PROVIDER_KINDS } from './views';

export const AiProviderKindInput = z.enum(AI_PROVIDER_KINDS);
export type AiProviderKindInput = z.infer<typeof AiProviderKindInput>;

/** Save (or update) one upstream provider. The key is write-only. */
export const SetAiProviderInput = z.object({
  kind: AiProviderKindInput,
  /** Provider API key — encrypted at rest, never returned. Omit to keep. */
  apiKey: z.string().min(1).max(500).optional(),
  /** Base URL override (required for `custom`). */
  baseUrl: z.string().trim().url().max(300).optional(),
  /** Route unknown model prefixes to this provider. */
  makeDefault: z.boolean().default(false),
});
export type SetAiProviderInput = z.infer<typeof SetAiProviderInput>;

export const RemoveAiProviderInput = z.object({ kind: AiProviderKindInput });
export type RemoveAiProviderInput = z.infer<typeof RemoveAiProviderInput>;

/** Mint a virtual key (shown once). Limits are optional. */
export const MintAiKeyInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._\/:-]*$/, 'invalid key name'),
  /** Optional `<stack>/<service>` marker for keys minted for an app. */
  appRef: z.string().trim().max(120).optional(),
  /** Requests per minute (sliding window). */
  rpm: z.number().int().min(1).max(100000).optional(),
  /** Daily spend cap in USD (estimated cost). */
  dailyBudgetUsd: z.number().min(0.01).max(100000).optional(),
});
export type MintAiKeyInput = z.infer<typeof MintAiKeyInput>;

export const AiUsageInput = z.object({
  days: z.number().int().min(1).max(90).default(14),
  keyId: z.string().min(1).optional(),
});
export type AiUsageInput = z.infer<typeof AiUsageInput>;

export const AiLogsInput = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  keyId: z.string().min(1).optional(),
});
export type AiLogsInput = z.infer<typeof AiLogsInput>;

export const AiSettingsInput = z.object({
  auditLog: z.boolean().optional(),
  cache: z.boolean().optional(),
});
export type AiSettingsInput = z.infer<typeof AiSettingsInput>;

/** Wire an app service to the gateway (mints a key into a Docker secret). */
export const AttachAiInput = z.object({
  stack: z.string().min(1).max(63),
  appService: z.string().min(1),
});
export type AttachAiInput = z.infer<typeof AttachAiInput>;

// ── Vector store (slice F5) — qdrant instances + pgvector enablement ──────────

/** Provision a managed qdrant instance. */
export const ProvisionVectorInput = z.object({
  stack: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid stack name'),
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid instance name'),
  /** Optionally wire an app service right after provisioning. */
  attachService: z.string().min(1).optional(),
});
export type ProvisionVectorInput = z.infer<typeof ProvisionVectorInput>;

/** Wire an app service to a qdrant instance (URL env + key Docker secret). */
export const AttachVectorInput = z.object({
  stack: z.string().min(1).max(63),
  name: z.string().min(1).max(40),
  appService: z.string().min(1),
  envVar: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid env var name')
    .default('QDRANT_URL'),
});
export type AttachVectorInput = z.infer<typeof AttachVectorInput>;

/** Enable the pgvector extension on a managed Postgres cluster. */
export const EnablePgvectorInput = z.object({
  stack: z.string().min(1).max(63),
  cluster: z.string().min(1).max(40),
});
export type EnablePgvectorInput = z.infer<typeof EnablePgvectorInput>;

// ── Notifications (slice F6) — provider config, templates, delivery log ───────
import { NOTIFY_DELIVERY_STATUSES, NOTIFY_PROVIDERS } from './views';

export const NotifyProviderInput = z.enum(NOTIFY_PROVIDERS);
export type NotifyProviderInput = z.infer<typeof NotifyProviderInput>;

/** SMTP credentials (nodemailer transport). `pass` is write-only. */
export const NotifySmtpInput = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().trim().max(255).optional(),
  /** Write-only; omit to keep the stored password. */
  pass: z.string().max(500).optional(),
});
export type NotifySmtpInput = z.infer<typeof NotifySmtpInput>;

export const NotifyResendInput = z.object({
  /** Write-only API key (`re_…`); omit to keep the stored key. */
  apiKey: z.string().trim().max(500).optional(),
});
export type NotifyResendInput = z.infer<typeof NotifyResendInput>;

export const NotifyPostmarkInput = z.object({
  /** Write-only server token; omit to keep the stored token. */
  serverToken: z.string().trim().max(500).optional(),
});
export type NotifyPostmarkInput = z.infer<typeof NotifyPostmarkInput>;

export const NotifyMailgunInput = z.object({
  /** Write-only API key; omit to keep the stored key. */
  apiKey: z.string().trim().max(500).optional(),
  domain: z.string().trim().min(1).max(255),
  /** Regional API base (default `https://api.mailgun.net`; EU: `https://api.eu.mailgun.net`). */
  baseUrl: z.string().trim().url().max(300).optional(),
});
export type NotifyMailgunInput = z.infer<typeof NotifyMailgunInput>;

/**
 * Save the org's email provider. Exactly the block matching `provider` is read;
 * secret fields are write-only (omit to keep what is stored).
 */
export const SetNotifyConfigInput = z.object({
  provider: NotifyProviderInput,
  fromAddress: z.string().trim().email().max(254),
  smtp: NotifySmtpInput.optional(),
  resend: NotifyResendInput.optional(),
  postmark: NotifyPostmarkInput.optional(),
  mailgun: NotifyMailgunInput.optional(),
});
export type SetNotifyConfigInput = z.infer<typeof SetNotifyConfigInput>;

export const NotifyTestSendInput = z.object({
  to: z.string().trim().email().max(254),
});
export type NotifyTestSendInput = z.infer<typeof NotifyTestSendInput>;

/** Create (no id) or update (id set) a template. */
export const SaveNotifyTemplateInput = z.object({
  id: z.string().min(1).optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'letters, digits, dots, dashes'),
  subject: z.string().trim().min(1).max(200),
  bodyText: z.string().max(20_000).optional(),
  bodyHtml: z.string().max(50_000).optional(),
});
export type SaveNotifyTemplateInput = z.infer<typeof SaveNotifyTemplateInput>;

export const NotifyTemplateRefInput = z.object({ id: z.string().min(1) });
export type NotifyTemplateRefInput = z.infer<typeof NotifyTemplateRefInput>;

export const NotifyDeliveriesInput = z.object({
  status: z.enum(NOTIFY_DELIVERY_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type NotifyDeliveriesInput = z.infer<typeof NotifyDeliveriesInput>;

// ── Canary rollouts (slice D2) — start / promote / abort / status ─────────────

/** Start a weighted canary next to a running stack service. */
export const StartCanaryInput = z.object({
  stack: z.string().min(1).max(63),
  /** Stable service — Docker service name (`storefront_web`), short name or id. */
  service: z.string().min(1).max(255),
  /** The candidate image (with tag) the canary runs. */
  image: z.string().min(1).max(255),
  /** Share of ingress traffic sent to the canary (1–99%). */
  trafficPct: z.number().int().min(1).max(99).default(10),
  /** Watch window in minutes; a clean window auto-promotes. */
  durationMin: z.number().int().min(1).max(1440).default(15),
  /** Canary error-rate ceiling (percent) that auto-rolls back; null disables. */
  rollbackOnErrorRatePct: z.number().min(0.1).max(100).nullable().default(5),
});
export type StartCanaryInput = z.infer<typeof StartCanaryInput>;

/** Address one in-flight canary by its stable service. */
export const CanaryRefInput = z.object({
  stack: z.string().min(1).max(63),
  service: z.string().min(1).max(255),
});
export type CanaryRefInput = z.infer<typeof CanaryRefInput>;

export const CanaryStatusInput = z.object({
  /** Restrict to one stack's canaries; omit for the whole org. */
  stack: z.string().min(1).max(63).optional(),
});
export type CanaryStatusInput = z.infer<typeof CanaryStatusInput>;

// ── PR preview environments (slice D4) — appended, additive ──────────────────

/** Address one git repo's preview settings. */
export const PreviewRepoRefInput = z.object({ repoId: z.string().min(1) });
export type PreviewRepoRefInput = z.infer<typeof PreviewRepoRefInput>;

/** Save a repo's preview settings (stored as `GitRepo.previewsJson`). */
export const SetPreviewSettingsInput = z.object({
  repoId: z.string().min(1),
  enabled: z.boolean(),
  /** DNS domain previews publish under (`preview.example.com`); empty = no route. */
  baseDomain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(
      /^$|^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
      'a DNS domain like preview.example.com',
    )
    .default(''),
  /** Hours a preview lives after its last deploy (0 = never expire). */
  ttlHours: z.number().int().min(0).max(720).default(72),
  teardownOnClose: z.boolean().default(true),
});
export type SetPreviewSettingsInput = z.infer<typeof SetPreviewSettingsInput>;

/** Spin up a preview for a branch without a PR (pseudo-PR number is derived). */
export const CreateManualPreviewInput = z.object({
  repoId: z.string().min(1),
  branch: z.string().trim().min(1).max(200),
});
export type CreateManualPreviewInput = z.infer<typeof CreateManualPreviewInput>;

/** Tear down one preview stack by its Docker stack namespace (`pr142-shop`). */
export const DestroyPreviewInput = z.object({
  stack: z.string().trim().min(1).max(63),
});
export type DestroyPreviewInput = z.infer<typeof DestroyPreviewInput>;
