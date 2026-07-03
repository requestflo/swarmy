/**
 * Display/view types returned by tRPC to the dashboard. Plain TS interfaces
 * (no Zod) — these are controller→browser shapes, distinct from the wire
 * protocol's agent→controller frames.
 */

export type NodeRole = 'manager' | 'worker';
export type NodeStatusView = 'pending' | 'online' | 'offline' | 'draining';
export type ServiceStatusView =
  | 'pending'
  | 'deploying'
  | 'running'
  | 'degraded'
  | 'stopped'
  | 'failed'
  | 'removing';
export type DeployPhase =
  | 'queued'
  | 'pulling'
  | 'creating'
  | 'converging'
  | 'complete'
  | 'failed'
  | 'rolledback'
  | 'canceled';

export interface NodeSummary {
  id: string;
  name: string;
  hostname: string;
  role: NodeRole;
  /** Carries the ingress-edge role label (`swarmy.node.ingress=true`). */
  ingress?: boolean;
  /** Carries the egress-outlet role label (`swarmy.node.outlet=true`). */
  outlet?: boolean;
  /** Region label (`swarmy.region`), or null if unset. */
  region?: string | null;
  status: NodeStatusView;
  engineVersion: string | null;
  os: string | null;
  arch: string | null;
  resources: { cpus: number | null; memBytes: number | null };
  agentVersion: string | null;
  lastSeenAt: string | null;
  /** Most recent live snapshot, if the node is connected. */
  live: { cpuPercent: number; memPercent: number } | null;
}

export interface NodeDetail extends NodeSummary {
  ipAddress: string | null;
  swarmNodeId: string | null;
  labels: Record<string, string>;
  joinedAt: string;
}

export interface NodeStatsSnapshot {
  nodeId: string;
  ts: number;
  cpuPercent: number;
  cpuCount: number;
  memUsedBytes: number;
  memTotalBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  fsUsedBytes: number | null;
  fsTotalBytes: number | null;
}

export interface ContainerStatsSnapshot {
  containerId: string;
  name: string;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
}

export interface ClusterStatsFrame {
  ts: number;
  nodesOnline: number;
  nodesTotal: number;
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  containersRunning: number;
}

export interface ServiceReplicas {
  desired: number;
  running: number;
}

export interface ServiceSummary {
  id: string;
  name: string;
  image: string;
  status: ServiceStatusView;
  replicas: ServiceReplicas;
  ingressEnabled: boolean;
  nodeId: string | null;
  stackId: string | null;
  updatedAt: string;
}

export interface ServiceDetail extends ServiceSummary {
  env: Record<string, string>;
  ports: Array<{ target: number; published?: number; protocol: string; mode: string }>;
  volumes: Array<{ type: string; source?: string; target: string; readOnly: boolean }>;
  networks: string[];
  constraints: string[];
  swarmServiceId: string | null;
  createdAt: string;
  scaleToZero?: { enabled: boolean; targetReplicas: number; idleSeconds: number };
}

/** Live swarm state for a service, read from the gateway's in-memory snapshot. */
export interface ServiceStateSnapshot {
  serviceName: string;
  desiredReplicas: number | null;
  runningReplicas: number;
  updateStatus: string | null;
}

export interface DeployStatus {
  deploymentId: string;
  serviceId: string | null;
  kind: string;
  phase: DeployPhase;
  desired: number | null;
  ready: number | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface LogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  ts: number | null;
  message: string;
}

export interface TaskState {
  id: string;
  nodeId: string | null;
  state: string;
  desiredState: string;
  error: string | null;
}

export interface DashboardSummary {
  nodes: { online: number; total: number };
  services: { running: number; total: number };
  containersRunning: number;
  recentDeployments: number;
  cpuPercent: number;
  memPercent: number;
}

// ── D1 releases: release history + health-gated deploys + rollback ──────────

export type ReleaseStatusView = 'deploying' | 'healthy' | 'failed' | 'rolled-back' | 'superseded';

/** One resolved image a release deployed (service name → image ref w/ tag). */
export interface ReleaseImageView {
  name: string;
  image: string;
}

/** Deploy strategy carried on the `swarmy.deploy.strategy` stack label (D2). */
export interface DeployStrategyView {
  type: 'rolling' | 'canary' | 'bluegreen';
  trafficPct?: number;
  durationMin?: number;
  rollbackOnErrorRatePct?: number;
}

/** Health gate carried on the `swarmy.deploy.safety` stack label. */
export interface HealthGateView {
  windowSec: number;
  autoRollback: boolean;
}

export interface ReleaseView {
  id: string;
  stackName: string;
  status: ReleaseStatusView;
  images: ReleaseImageView[];
  actor: string | null;
  strategy: DeployStrategyView | null;
  healthGate: HealthGateView | null;
  notes: string | null;
  createdAt: string;
}

export type ComposeDiffKind = 'same' | 'add' | 'del';

/** One line of the compose diff between a release and its predecessor. */
export interface ComposeDiffLine {
  kind: ComposeDiffKind;
  /** 1-based line number in the previous compose (null for additions). */
  aLine: number | null;
  /** 1-based line number in this release's compose (null for deletions). */
  bLine: number | null;
  text: string;
}

export interface ReleaseDetailView extends ReleaseView {
  composeSource: string;
  /** The release this one is diffed against (previous deploy of the stack). */
  previousId: string | null;
  diff: ComposeDiffLine[];
}

/** Per-stack deploy-safety settings read back from the stack's Docker labels. */
export interface DeploySafetyView {
  stackName: string;
  enabled: boolean;
  windowSec: number;
  autoRollback: boolean;
  strategy: DeployStrategyView | null;
}

/** Counts for the Releases page hero. */
export interface ReleasesOverview {
  total: number;
  deploying: number;
  healthy: number;
  failed: number;
  rolledBack: number;
  lastDeployAt: string | null;
}

// ── DB backups (slice A1) — dashboard views over Docker-truth backup labels ──
import type { DbBackupEngine as DbBackupEngineKind } from './protocol/dbBackup';

export type DbBackupRunStatus = 'succeeded' | 'failed';

/** The cluster's recurring-backup schedule (`swarmy.db.backup.schedule` label). */
export interface DbBackupScheduleView {
  stack: string;
  cluster: string;
  cron: string;
  engine: DbBackupEngineKind;
  retentionDays: number;
  pitr: boolean;
  targetId: string | null;
  dataVolume: string | null;
  lastRunAt: string | null;
  lastStatus: DbBackupRunStatus | null;
  nextRunAt: string | null;
}

/** One DB backup in the restic catalog, projected for the dashboard. */
export interface DbBackupSnapshotView {
  id: string;
  /** ISO time the snapshot was taken. */
  time: string;
  engine: DbBackupEngineKind | null;
  /** Stringified bytes (BigInt-safe), or null when restic did not report a size. */
  sizeBytes: string | null;
  tags: string[];
}

/** One row of the org-wide database-backup coverage table (Backups page). */
export interface DbBackupOverviewRow {
  stack: string;
  cluster: string;
  scheduled: boolean;
  cron: string | null;
  engine: DbBackupEngineKind | null;
  retentionDays: number | null;
  pitr: boolean;
  targetId: string | null;
  targetName: string | null;
  lastBackupAt: string | null;
  lastStatus: DbBackupRunStatus | null;
  lastSizeBytes: string | null;
  nextRunAt: string | null;
  /** Restorable point-in-time span (PITR clusters with a successful backup). */
  pitrWindow: { from: string; to: string } | null;
}

// ── Managed-DB topology view fragments (shared by the topology selector UI) ──
export type DbTopologyMode = 'single' | 'primary-replica' | 'failover' | 'geo' | 'active-active';

export interface DbGeoRegionPlan {
  region: string;
  replicas: number;
}

export interface DbTopologyConfigView {
  topology: DbTopologyMode;
  /** Region that owns the single writer (geo / failover). */
  writeRegion?: string;
  regions?: DbGeoRegionPlan[];
}

// ── Registry policy — image scanning / signing / admission (platform buildout, D3) ──

export type ImageScanStatusKind = 'passed' | 'failed' | 'error';

/** Org registry admission policy toggles (RegistryConfig columns, slice D3). */
export interface RegistryPolicyView {
  requireSignedImages: boolean;
  blockCriticalCves: boolean;
  /** True once the org cosign keypair exists (public key stored). */
  signingEnabled: boolean;
  updatedAt: string;
}

/** One trivy CVE scan of a built image (row of the CI scans table). */
export interface ImageScanView {
  id: string;
  imageRef: string;
  digest: string | null;
  scanner: string;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  status: ImageScanStatusKind;
  scannedAt: string;
}

/** One CVE surfaced in the scan-detail drawer (trimmed from the trivy report). */
export interface ImageScanCveView {
  id: string;
  severity: string;
  pkgName: string;
  installedVersion: string;
  fixedVersion: string | null;
  title: string | null;
}

/** Scan detail: the scan row plus its top CVEs (report trimmed server-side). */
export interface ImageScanDetailView extends ImageScanView {
  cves: ImageScanCveView[];
  /** Total vulnerabilities found (may exceed `cves.length` after trimming). */
  totalCves: number;
  /** Present when the scan errored (exec/parse failure). */
  error: string | null;
}

/** Org image-signing status. The private key never leaves the vault. */
export interface SigningStatusView {
  enabled: boolean;
  publicKey: string | null;
}

// ── Managed cache (slice A3) — views over Docker-truth `swarmy.cache.*` labels ──
import type { InvServiceStatus as CacheServiceStatus } from './inventory';

/** Supported cache engines (valkey is the default). */
export const CACHE_ENGINES = ['valkey', 'redis'] as const;
export type CacheEngine = (typeof CACHE_ENGINES)[number];

/** Selectable cache topologies. Order = least→most advanced. */
export const CACHE_TOPOLOGIES = ['single', 'replica', 'sentinel'] as const;
export type CacheTopology = (typeof CACHE_TOPOLOGIES)[number];

export type CacheRole = 'primary' | 'replica' | 'sentinel';

/**
 * A live `INFO` sample from the cluster primary. Also the JSON payload of the
 * `swarmy.cache.stats` label the cache-reconcile worker stamps each tick.
 */
export interface CacheStatsView {
  usedMemoryBytes: number;
  maxMemoryBytes: number;
  connectedClients: number;
  opsPerSec: number;
  /** Total keys across all keyspaces (`dbN:keys=…`). */
  keys: number;
  /** keyspace_hits / (hits+misses) × 100, or null before any lookups. */
  hitRatePct: number | null;
  /** ISO time the sample was taken. */
  at: string;
}

/** One live cluster member service with its Docker-truth role + health. */
export interface CacheMemberView {
  service: string;
  role: CacheRole;
  /** Region a region-pinned replica sibling is pinned to (`swarmy.cache.region`). */
  region?: string;
  status: CacheServiceStatus | 'absent';
  desired: number;
  running: number;
}

/** An app service wired to the cluster (`swarmy.cache.inject` labels). */
export interface CacheAttachmentView {
  service: string;
  envVar: string;
}

/** One managed cache cluster, projected straight off the live inventory. */
export interface CacheClusterView {
  stack: string;
  name: string;
  engine: CacheEngine;
  topology: CacheTopology;
  /** Declared maxmemory in MB (`swarmy.cache.memoryMb`). */
  memoryMb: number;
  /** Declared replica count (`swarmy.cache.replicas` — the reconcile target). */
  declaredReplicas: number;
  primary: { service: string; status: CacheServiceStatus | 'absent' };
  replicas: { desired: number; running: number };
  sentinels: { desired: number; running: number };
  /** Swarm DNS host apps connect to (the primary service name). */
  host: string;
  port: number;
  /** Docker secret name carrying the cluster password (value never returned). */
  passwordSecret: string;
  members: CacheMemberView[];
  /** Per-region replica declarations (`swarmy.cache.region.<r>.replicas`). */
  regionReplicas?: Record<string, number>;
  /** Last stats stamp (`swarmy.cache.stats`), or null before the first sample. */
  stats: CacheStatsView | null;
  attachments: CacheAttachmentView[];
}

/** One cache snapshot in the restic catalog (tag `cache:<stack>_<cluster>`). */
export interface CacheBackupView {
  id: string;
  time: string;
  /** Stringified bytes (BigInt-safe), or null when restic omitted a size. */
  sizeBytes: string | null;
  tags: string[];
}

/** Returned ONCE by cache.provision — the password is not retrievable later. */
export interface CacheProvisionResult {
  stack: string;
  cluster: string;
  engine: CacheEngine;
  topology: CacheTopology;
  host: string;
  port: number;
  passwordSecret: string;
  /** Generated cluster password; surfaced once, stored only as a Docker secret. */
  password: string;
}

// ── Object storage — Garage buckets (slice A4) ────────────────────────────────

/** Reachability of the org's managed Garage store for the buckets surface. */
export type BucketStoreState = 'ready' | 'disabled' | 'unreachable';

export interface BucketPermissionsView {
  read: boolean;
  write: boolean;
  owner: boolean;
}

export interface BucketQuotaView {
  /** Max stored bytes; null = unlimited. */
  maxSizeBytes: number | null;
  /** Max object count; null = unlimited. */
  maxObjects: number | null;
}

/** One access key granted on a bucket (from Garage bucket info). */
export interface BucketKeyGrantView {
  accessKeyId: string;
  name: string;
  permissions: BucketPermissionsView;
}

export interface BucketSummaryView {
  /** Garage bucket id (hex). */
  id: string;
  /** Global alias — the name apps use. */
  name: string;
  usageBytes: number;
  objects: number;
  unfinishedUploads: number;
  /** True when the bucket serves a public website (off by default). */
  website: boolean;
  quotas: BucketQuotaView;
  keyCount: number;
}

/** An app service wired to a bucket (Docker-truth: `swarmy.s3.*` labels). */
export interface BucketAttachmentView {
  service: string;
  stack: string;
  accessKeyId: string;
  /** Docker secret name carrying S3_SECRET_ACCESS_KEY (value never returned). */
  secretName: string;
}

export interface BucketDetailView extends BucketSummaryView {
  keys: BucketKeyGrantView[];
  attachments: BucketAttachmentView[];
}

export interface BucketsOverview {
  state: BucketStoreState;
  /** In-swarm S3 endpoint attached apps receive as S3_ENDPOINT. */
  endpoint: string | null;
  region: string;
  buckets: BucketSummaryView[];
  /** Human hint when state != ready. */
  message?: string;
}

export interface StorageAccessKeyView {
  id: string;
  name: string;
}

export interface BucketKeysView {
  state: BucketStoreState;
  keys: StorageAccessKeyView[];
}

/** Returned ONCE by buckets.createKey — the secret is never retrievable again. */
export interface BucketKeyCreatedView {
  accessKeyId: string;
  secretAccessKey: string;
  name: string;
}

export interface BucketAttachResult {
  appService: string;
  bucket: string;
  accessKeyId: string;
  /** Docker secret injected as S3_SECRET_ACCESS_KEY_FILE (value never returned). */
  secretName: string;
  endpoint: string;
  region: string;
}

// ── Queues (slice B1) — Docker-truth `swarmy.queues` label on WORKER services ──

/** Queue key conventions swarmy understands (BullMQ keys, or one raw list). */
export const QUEUE_CONVENTIONS = ['bullmq', 'list'] as const;
export type QueueConvention = (typeof QUEUE_CONVENTIONS)[number];

/** One queue definition — an element of the `swarmy.queues` JSON label array. */
export interface QueueDef {
  /** Queue name (BullMQ queue name, or the display name for a raw list). */
  name: string;
  /** Backing managed cache: `<cluster>` (worker's stack) or `<stack>/<cluster>`. */
  cacheCluster: string;
  convention: QueueConvention;
  /** Raw list key (convention `list` only; defaults to the queue name). */
  listKey?: string;
  /** Autoscale slope: one worker replica per this many waiting jobs. */
  scalePerJobs: number;
  minWorkers: number;
  maxWorkers: number;
  /** Consumer retry budget (informational — the consumer library enforces it). */
  retries: number;
  /** Whether a `<queue>:dead` dead-letter list is expected/browsable. */
  dlq: boolean;
}

/** One depth sample — an entry of the `swarmy.queues.stats` JSON label. */
export interface QueueDepthSample {
  wait: number;
  active: number;
  failed: number;
  delayed: number;
  /** ISO time the sample was taken. */
  ts: string;
}

/** One queue projected for the dashboard (def + live worker state + last sample). */
export interface QueueView extends QueueDef {
  /** Docker service name of the worker consuming the queue. */
  workerService: string;
  /** Stack the worker service belongs to. */
  stack: string;
  /** Normalized backing-cluster ref (stack part). */
  cacheStack: string;
  /** Normalized backing-cluster ref (cluster part). */
  cacheName: string;
  /** True when the cache cluster primary is running in the live inventory. */
  cacheOnline: boolean;
  /** Live worker replica counts on the worker service. */
  workers: { desired: number; running: number };
  /** Last depth sample (stamped by queue-reconcile), or null before the first. */
  stats: QueueDepthSample | null;
}

/** Aggregates for the Queues page hero. */
export interface QueuesOverview {
  queues: number;
  /** Running replicas across distinct worker services carrying queue defs. */
  workersRunning: number;
  totalWait: number;
  totalActive: number;
  totalFailed: number;
}

/** One dead-letter entry (payload tail — truncated server-side). */
export interface QueueDlqItemView {
  index: number;
  payload: string;
}

/** Result of a bounded retry-failed batch (BullMQ failed → wait). */
export interface QueueRetryResult {
  queue: string;
  moved: number;
  /** Failed jobs still left after the batch. */
  remaining: number;
}

/** Result of draining a queue (waiting + delayed jobs deleted). */
export interface QueueDrainResult {
  queue: string;
  removed: number;
}

/** Result of a bounded DLQ requeue batch (dead → wait). */
export interface QueueRequeueResult {
  queue: string;
  moved: number;
  /** Dead-letter entries still left after the batch. */
  remaining: number;
}

// ── Scheduled jobs (slice B2) — cron-fired one-shot containers / service execs ─

export const JOB_KINDS = ['image', 'service-exec'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_RUN_STATUSES = ['running', 'succeeded', 'failed', 'timeout'] as const;
export type JobRunStatusView = (typeof JOB_RUN_STATUSES)[number];

/** Placement constraints for `image` jobs (mirrors `ScheduledJob.runOnJson`). */
export interface JobRunOnView {
  /** Pin to one node (controller node id or name). */
  nodeId?: string;
  /** Require these swarm node labels (all must match). */
  labels?: Record<string, string>;
}

/** One execution attempt of a scheduled job (mirrors a `JobRun` row). */
export interface JobRunView {
  id: string;
  jobId: string;
  status: JobRunStatusView;
  exitCode: number | null;
  /** Combined stdout+stderr tail (≤64KB, captured by the agent). */
  outputTail: string | null;
  /** 1-based attempt number within one fire (retries create new rows). */
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
}

/** One scheduled job projected for the Jobs table. */
export interface ScheduledJobView {
  id: string;
  name: string;
  /** Raw 5-field cron expression (UTC). */
  schedule: string;
  /** Human description of the schedule ("every day 02:00"). */
  scheduleText: string;
  kind: JobKind;
  image: string | null;
  serviceRef: string | null;
  command: string[];
  env: Record<string, string>;
  runOn: JobRunOnView;
  timeoutMs: number;
  retries: number;
  alertOnFailure: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  /** Status of the most recent run, or null before the first. */
  lastRunStatus: JobRunStatusView | null;
  /** Next cron occurrence (UTC), or null when disabled/unparseable. */
  nextRunAt: string | null;
  createdAt: string;
}

/** Aggregates for the Jobs page hero. */
export interface JobsOverview {
  total: number;
  enabled: number;
  succeeded24h: number;
  failed24h: number;
  /** Soonest upcoming run across enabled jobs, or null. */
  nextRunAt: string | null;
  nextJobName: string | null;
}

/** One page of run history (cursor pagination, newest first). */
export interface JobRunsPage {
  runs: JobRunView[];
  nextCursor: string | null;
}

/** Live "next 3 runs" preview for the schedule editor (`jobs.previewSchedule`). */
export interface SchedulePreview {
  valid: boolean;
  scheduleText: string;
  /** Upcoming occurrences (ISO, UTC) — empty when invalid. */
  next: string[];
  error: string | null;
}

// ── Workflows (slice B3) — sequential multi-step automations w/ approvals ─────

export const WORKFLOW_STEP_KINDS = [
  'container',
  'service-exec',
  'webhook',
  'approval',
  'delay',
] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export const WORKFLOW_RUN_STATUSES = [
  'running',
  'waiting-approval',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatusView = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_STEP_STATUSES = [
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type WorkflowStepStatusView = (typeof WORKFLOW_STEP_STATUSES)[number];

/**
 * One step's config as STORED in `WorkflowDef.stepsJson`. Which fields apply
 * depends on `kind`; a webhook's HMAC secret is vault-encrypted (`secretEnc`)
 * before it ever reaches the row — plaintext is never persisted or returned.
 */
export interface WorkflowStepConfig {
  /** container: image to run once. */
  image?: string;
  /** container / service-exec: argv to run. */
  command?: string[];
  /** container: environment for the one-shot container. */
  env?: Record<string, string>;
  /** service-exec: target service (Docker id or name, live-resolved). */
  serviceRef?: string;
  /** webhook: POST target URL. */
  url?: string;
  /** webhook: vault-encrypted HMAC secret (see crypto.encryptSecret). */
  secretEnc?: string;
  /** approval: question shown to the approver. */
  prompt?: string;
  /** delay: seconds to pause before the next step. */
  seconds?: number;
}

/** One step definition — an element of the `WorkflowDef.stepsJson` array. */
export interface WorkflowStepDef {
  name: string;
  kind: WorkflowStepKind;
  config: WorkflowStepConfig;
  /** Per-attempt budget for executing kinds (default 10 min). */
  timeoutMs?: number;
  /** Extra attempts after the first for executing kinds (default 0). */
  retries?: number;
}

/** Per-step record accumulated in `WorkflowRun.stateJson.steps`. */
export interface WorkflowStepRecord {
  name: string;
  /** Step output (becomes the next step's `prevOutput`). */
  output?: unknown;
  error?: string;
}

/** The `WorkflowRun.stateJson` shape the runner advances. */
export interface WorkflowRunState {
  /** Trigger payload (webhook body / manual JSON). */
  input: unknown;
  /** One record per COMPLETED step, in order. */
  steps: WorkflowStepRecord[];
  /** delay steps: ISO time the run becomes eligible to advance again. */
  nextEligibleAt?: string;
}

/** A step as shown to the browser — secrets reduced to a presence flag. */
export interface WorkflowStepView {
  name: string;
  kind: WorkflowStepKind;
  config: {
    image?: string;
    command?: string[];
    env?: Record<string, string>;
    serviceRef?: string;
    url?: string;
    /** True when a webhook HMAC secret is stored (value never returned). */
    hasSecret?: boolean;
    prompt?: string;
    seconds?: number;
  };
  timeoutMs: number | null;
  retries: number | null;
}

/** Latest version of one workflow definition (defs list). */
export interface WorkflowDefView {
  id: string;
  name: string;
  version: number;
  /** How many version rows exist for this name (edit history). */
  versions: number;
  enabled: boolean;
  steps: WorkflowStepView[];
  lastRunAt: string | null;
  lastRunStatus: WorkflowRunStatusView | null;
  createdAt: string;
  updatedAt: string;
}

/** One historical version row (`workflows.versions`). */
export interface WorkflowDefVersionView {
  id: string;
  version: number;
  stepCount: number;
  stepNames: string[];
  enabled: boolean;
  createdAt: string;
}

/** One run projected for the runs table. */
export interface WorkflowRunView {
  id: string;
  defId: string;
  defName: string;
  defVersion: number;
  /** Stack the workflow def belongs to (null = org-wide/legacy). */
  stackName: string | null;
  status: WorkflowRunStatusView;
  /** Index of the step the runner executes next. */
  cursor: number;
  totalSteps: number;
  /** Name of the current (or last) step, for at-a-glance progress. */
  currentStep: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** finishedAt−startedAt, or elapsed-so-far for live runs. */
  durationMs: number;
}

/** One step-run row of the run-detail timeline. */
export interface WorkflowStepRunView {
  index: number;
  name: string;
  kind: WorkflowStepKind;
  status: WorkflowStepStatusView;
  startedAt: string | null;
  finishedAt: string | null;
  /** Pretty-printed output JSON (≤8KB), or null before completion. */
  output: string | null;
  error: string | null;
}

/** Run detail: the run + its full step timeline + approval context. */
export interface WorkflowRunDetailView extends WorkflowRunView {
  /** Pretty-printed trigger input, or null when triggered without one. */
  input: string | null;
  steps: WorkflowStepRunView[];
  /** The waiting approval step's prompt (status = waiting-approval only). */
  approvalPrompt: string | null;
}

/** One page of run history (cursor pagination, newest first). */
export interface WorkflowRunsPage {
  runs: WorkflowRunView[];
  nextCursor: string | null;
}

/** Aggregates for the Workflows page hero. */
export interface WorkflowsOverview {
  defs: number;
  enabled: number;
  running: number;
  waitingApproval: number;
  succeeded24h: number;
  failed24h: number;
}

// ── Inbound webhook gateway (slice B4) — public endpoints, verified deliveries ─

/** How an inbound endpoint verifies payloads (wire values, lowercase). */
export const INBOUND_VERIFY_KINDS = ['none', 'hmac', 'github', 'stripe'] as const;
export type InboundVerifyKindView = (typeof INBOUND_VERIFY_KINDS)[number];

/** Where verified deliveries go: a queue on a managed cache, or an HTTP POST. */
export const INBOUND_TARGET_KINDS = ['queue', 'forward'] as const;
export type InboundTargetKindView = (typeof INBOUND_TARGET_KINDS)[number];

export const INBOUND_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead'] as const;
export type InboundDeliveryStatusView = (typeof INBOUND_DELIVERY_STATUSES)[number];

/** Queue target — push into a queue on a managed cache cluster (B1 conventions). */
export interface InboundQueueTarget {
  kind: 'queue';
  /** Backing managed cache: `<cluster>` or `<stack>/<cluster>`. */
  cacheCluster: string;
  /** Queue name (BullMQ queue name, or the raw list key for `list`). */
  queue: string;
  convention: QueueConvention;
}

/** Forward target — controller POSTs the raw body to a reachable http(s) URL. */
export interface InboundForwardTarget {
  kind: 'forward';
  url: string;
}

/** The `InboundEndpoint.targetJson` shape (canonical, validated). */
export type InboundTarget = InboundQueueTarget | InboundForwardTarget;

/** One inbound endpoint projected for the dashboard. */
export interface InboundEndpointView {
  id: string;
  name: string;
  slug: string;
  /** Stack this endpoint belongs to (stack-scoped IA); null = org-wide/legacy. */
  stackName: string | null;
  /** Custom domain served at the edge (point a CNAME at the swarm); null = none. */
  domain: string | null;
  /** Public receiver URL (`<controller>/hooks/i/<org>/<slug>`) — paste into the provider. */
  url: string;
  verifyKind: InboundVerifyKindView;
  /** True when a verify secret is stored (the value is never returned). */
  hasSecret: boolean;
  target: InboundTarget;
  /** Handlebars-style body transform applied before delivery; null = pass-through. */
  transformTemplate: string | null;
  /** Handlebars-style templated ack body; null = default `{ok:true}` ack. */
  responseTemplate: string | null;
  retentionDays: number;
  /** Deliveries received in the last 24h. */
  deliveries24h: number;
  lastDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One delivery row for the feed (body fetched separately via `delivery`). */
export interface InboundDeliveryView {
  id: string;
  endpointId: string;
  endpointName: string;
  endpointSlug: string;
  targetKind: InboundTargetKindView;
  receivedAt: string;
  verifyOk: boolean;
  status: InboundDeliveryStatusView;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** Stored body size in bytes (capped at 256KB by the receiver). */
  bodyBytes: number;
}

/** Payload inspector detail: the delivery + captured headers + raw body. */
export interface InboundDeliveryDetailView extends InboundDeliveryView {
  headers: Record<string, string>;
  body: string;
}

/** One page of the deliveries feed (cursor pagination, newest first). */
export interface InboundDeliveriesPage {
  deliveries: InboundDeliveryView[];
  nextCursor: string | null;
}

/** Aggregates for the Webhooks page hero. */
export interface InboundWebhooksOverview {
  endpoints: number;
  deliveries24h: number;
  failed24h: number;
  pending: number;
  dead: number;
}

// ── Observability logs (slice C1) ─────────────────────────────────────────────

/** Canonical severity buckets, ordered ascending (OTel severity-number groups). */
export const LOG_SEVERITIES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogSeverityView = (typeof LOG_SEVERITIES)[number];

/** OTel severity-number floor of each bucket (TRACE=1..4, DEBUG=5..8, …). */
export const LOG_SEVERITY_FLOORS: Record<LogSeverityView, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

/** Bucket an OTel severity number (unknown/0 counts as `info`). */
export function logSeverityFromNumber(n: number): LogSeverityView {
  if (n >= 21) return 'fatal';
  if (n >= 17) return 'error';
  if (n >= 13) return 'warn';
  if (n >= 9) return 'info';
  if (n >= 5) return 'debug';
  if (n >= 1) return 'trace';
  return 'info';
}

/**
 * One `otel_logs` row as returned by `observability.logs` — field names mirror
 * the ClickHouse column aliases (JSONEachRow output), like `TraceRow`/`SpanRow`.
 */
export interface LogRowView {
  /** Human-readable timestamp (`toString(Timestamp)`). */
  timestamp: string;
  /** Nanoseconds since epoch as a string — the descending pagination cursor. */
  ts_nano: string;
  trace_id: string;
  span_id: string;
  severity_text: string;
  severity_number: number;
  service_name: string;
  body: string;
  /** The row's `LogAttributes` map (structured context). */
  attributes: Record<string, string>;
}

/** One page of the logs feed — fail-open `{status}` like the other obs reads. */
export interface ObservabilityLogsPage {
  status: 'ok' | 'disabled' | 'unreachable';
  rows: LogRowView[];
  /** `ts_nano` of the last row when the page is full; null when exhausted. */
  nextCursor: string | null;
}

// ── Service map + health narrative (slice C2) ─────────────────────────────────

/** Overall health of a scope (the estate, one stack, or one service). */
export type HealthStatusView = 'healthy' | 'degraded' | 'down' | 'unknown';

/** One scoped entry of the narrative (a stack, or a single service). */
export interface HealthEntryView {
  kind: 'stack' | 'service';
  name: string;
  status: HealthStatusView;
  /** Ordered human reasons, worst first (empty when healthy). */
  reasons: string[];
}

/** The estate-wide health narrative behind `observability.health`. */
export interface HealthNarrativeView {
  status: HealthStatusView;
  /** Ordered reasons across the whole scope, worst first. */
  reasons: string[];
  /** Per-stack breakdown (or the single requested stack). */
  entries: HealthEntryView[];
  generatedAt: string;
}

/** One service node on the service map — RED over its inbound (entry) spans. */
export interface ServiceMapNodeView {
  /** OTel service name (`OTEL_SERVICE_NAME`). */
  id: string;
  callsPerMin: number;
  /** 0..1 share of entry spans with STATUS_CODE_ERROR. */
  errorRate: number;
  p95Ms: number;
  /** True when the node breaches the RED thresholds (tinted in the UI). */
  degraded: boolean;
}

/** One call edge: a client/producer span matched to its server/consumer child. */
export interface ServiceMapEdgeView {
  from: string;
  to: string;
  callsPerMin: number;
  errorRate: number;
  p95Ms: number;
}

/** The service map — fail-open `{status}` like the other observability reads. */
export interface ServiceMapView {
  status: 'ok' | 'disabled' | 'unreachable';
  windowMinutes: number;
  nodes: ServiceMapNodeView[];
  edges: ServiceMapEdgeView[];
}

// ── Alerts (slice C3) — rules, notification channels, firing/resolved events ──

/** Channel kinds swarmy can notify through. */
export const NOTIFICATION_CHANNEL_KINDS = ['email', 'slack', 'teams', 'webhook'] as const;
export type NotificationChannelKindView = (typeof NOTIFICATION_CHANNEL_KINDS)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverityView = (typeof ALERT_SEVERITIES)[number];

export const ALERT_EVENT_STATUSES = ['firing', 'resolved'] as const;
export type AlertEventStatusView = (typeof ALERT_EVENT_STATUSES)[number];

/** The signals the alert-evaluator understands (default rule per signal). */
export const ALERT_SIGNALS = [
  'node-offline',
  'service-down',
  'db-degraded',
  'db-failover',
  'backup-failed',
  'cert-expiry',
  'disk-usage',
  'queue-depth',
  'error-rate',
  'store-unreachable',
] as const;
export type AlertSignal = (typeof ALERT_SIGNALS)[number];

/** Catalog metadata for one signal — shared by the service seed and the UI. */
export interface AlertSignalInfo {
  label: string;
  description: string;
  /** Unit of `threshold` (null = the signal has no threshold). */
  unit: '%' | 'seconds' | 'jobs' | 'days' | null;
  defaultThreshold: number | null;
  defaultForSeconds: number;
  severity: AlertSeverityView;
}

/** The default rule catalog (one seeded rule per signal, editable in the UI). */
export const ALERT_SIGNAL_INFO: Record<AlertSignal, AlertSignalInfo> = {
  'node-offline': {
    label: 'Node offline',
    description: 'An enrolled node stopped heartbeating the controller.',
    unit: null,
    defaultThreshold: null,
    defaultForSeconds: 60,
    severity: 'critical',
  },
  'service-down': {
    label: 'Service down',
    description: 'A service is running fewer replicas than it wants.',
    unit: null,
    defaultThreshold: null,
    defaultForSeconds: 60,
    severity: 'warning',
  },
  'db-degraded': {
    label: 'Database degraded',
    description: 'A managed-database replica is lagging its primary.',
    unit: 'seconds',
    defaultThreshold: 30,
    defaultForSeconds: 0,
    severity: 'warning',
  },
  'db-failover': {
    label: 'Database failover',
    description: 'A managed-database cluster changed leader.',
    unit: null,
    defaultThreshold: null,
    defaultForSeconds: 0,
    severity: 'critical',
  },
  'backup-failed': {
    label: 'Backup failed',
    description: 'The most recent run of a backup schedule failed.',
    unit: null,
    defaultThreshold: null,
    defaultForSeconds: 0,
    severity: 'warning',
  },
  'cert-expiry': {
    label: 'Certificate expiring',
    description: 'A TLS certificate on an ingress domain expires soon.',
    unit: 'days',
    defaultThreshold: 14,
    defaultForSeconds: 0,
    severity: 'warning',
  },
  'disk-usage': {
    label: 'Disk almost full',
    description: 'A node’s filesystem usage crossed the threshold.',
    unit: '%',
    defaultThreshold: 80,
    defaultForSeconds: 0,
    severity: 'warning',
  },
  'queue-depth': {
    label: 'Queue backlog',
    description: 'A queue’s waiting jobs crossed the threshold.',
    unit: 'jobs',
    defaultThreshold: 1000,
    defaultForSeconds: 0,
    severity: 'warning',
  },
  'error-rate': {
    label: 'Error rate high',
    description: 'A service’s request error rate crossed the threshold.',
    unit: '%',
    defaultThreshold: 5,
    defaultForSeconds: 0,
    severity: 'warning',
  },
  'store-unreachable': {
    label: 'Telemetry store unreachable',
    description: 'The observability store stopped answering the controller.',
    unit: null,
    defaultThreshold: null,
    defaultForSeconds: 60,
    severity: 'warning',
  },
};

/** One notification channel (config stays encrypted; only a redacted target). */
export interface NotificationChannelView {
  id: string;
  name: string;
  kind: NotificationChannelKindView;
  enabled: boolean;
  /** Redacted destination — an email address or the webhook host. Never a secret. */
  target: string;
  /** Webhook channels: whether deliveries are HMAC-signed. */
  hasSecret: boolean;
  createdAt: string;
}

/** One alert rule (defaults are seeded per signal; thresholds editable). */
export interface AlertRuleView {
  id: string;
  name: string;
  signal: string;
  threshold: number | null;
  forSeconds: number;
  channelIds: string[];
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
}

/** One firing/resolved alert event. */
export interface AlertEventView {
  id: string;
  ruleId: string | null;
  ruleName: string | null;
  signal: string;
  severity: AlertSeverityView;
  resource: string;
  message: string;
  status: AlertEventStatusView;
  firedAt: string;
  resolvedAt: string | null;
}

/** Aggregates for the Alerts page hero + the shell bell badge. */
export interface AlertsOverview {
  firing: number;
  firingCritical: number;
  resolved24h: number;
  rules: number;
  rulesEnabled: number;
  channels: number;
}

/** Result of a channel test-send. */
export interface ChannelTestResult {
  ok: boolean;
  detail: string;
}

// ── Incidents (slice C4) — open/resolve lifecycle + event timeline ────────────

export const INCIDENT_STATUSES = ['open', 'resolved'] as const;
export type IncidentStatusView = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SEVERITIES = ['minor', 'major', 'critical'] as const;
export type IncidentSeverityView = (typeof INCIDENT_SEVERITIES)[number];

/** One incident, list shape (open first on the Incidents page). */
export interface IncidentView {
  id: string;
  title: string;
  status: IncidentStatusView;
  severity: IncidentSeverityView;
  /** Post-mortem summary, when someone wrote one. */
  summary: string | null;
  openedAt: string;
  resolvedAt: string | null;
  /** Open incidents: seconds since open. Resolved: total open→resolved span. */
  durationSec: number;
  eventCount: number;
  lastEventAt: string | null;
}

/**
 * One timeline entry. `kind` is an open vocabulary written by automation
 * (`opened`, `alert.fired`, `alert.resolved`, `db.failover`, `deploy.gate.*`,
 * `resolved`, `reopened`) plus the manual `note`.
 */
export interface IncidentEventView {
  id: string;
  at: string;
  kind: string;
  message: string;
  meta: Record<string, unknown>;
}

/** Incident detail: the list shape + the full timeline (oldest first). */
export interface IncidentDetailView extends IncidentView {
  events: IncidentEventView[];
}

/** Aggregates for the Incidents page hero. */
export interface IncidentsOverview {
  open: number;
  openCritical: number;
  resolved7d: number;
  total: number;
}

/** Trimmed incident shape for public status pages (C5 `publicIncidents`). */
export interface PublicIncidentView {
  id: string;
  title: string;
  status: IncidentStatusView;
  severity: IncidentSeverityView;
  openedAt: string;
  resolvedAt: string | null;
  /** Latest-first update feed (message + timestamp only — no meta). */
  updates: Array<{ at: string; kind: string; message: string }>;
}

// ── Status pages (slice C5) — public component status, uptime bars, incidents ─

export const STATUS_PAGE_COMPONENT_KINDS = [
  'service',
  'db',
  'cache',
  'region',
  'ingress',
] as const;
export type StatusPageComponentKind = (typeof STATUS_PAGE_COMPONENT_KINDS)[number];

/** Public status vocabulary — what a component (and the page banner) can show. */
export const PUBLIC_STATUSES = ['up', 'degraded', 'down'] as const;
export type PublicStatusValue = (typeof PUBLIC_STATUSES)[number];
/** A component with no signal yet (no samples, unknown ref) reads as `unknown`. */
export type PublicComponentStatus = PublicStatusValue | 'unknown';

/** One watched component on a status page (stored as `componentsJson`). */
export interface StatusPageComponent {
  /** Stable per-page key (kebab) — uptime samples are recorded against it. */
  key: string;
  /** Human label shown on the public page ("API", "Database"). */
  label: string;
  kind: StatusPageComponentKind;
  /** What it watches — a service name, db/cache cluster, region, or ingress service. */
  ref: string;
}

/** One status page, settings-surface shape. */
export interface StatusPageView {
  id: string;
  slug: string;
  title: string;
  domain: string | null;
  components: StatusPageComponent[];
  showUptime: boolean;
  showIncidents: boolean;
  enabled: boolean;
  /** Public SPA path for the preview link (`/s/<slug>`). */
  publicPath: string;
  createdAt: string;
  updatedAt: string;
}

/** Aggregates for the Status pages hero. */
export interface StatusPagesOverview {
  pages: number;
  enabled: number;
  components: number;
  samples24h: number;
}

/** One day of aggregated uptime for a component (`pct` 0..100; null = no samples). */
export interface UptimeDayView {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  pct: number | null;
}

/** One component on the public snapshot. */
export interface PublicComponentView {
  key: string;
  label: string;
  kind: StatusPageComponentKind;
  status: PublicComponentStatus;
  /** Oldest→newest, one entry per day in the window (missing days are null). */
  uptime90d: UptimeDayView[];
  /** Rolled-up uptime over the whole window (0..100; null = no samples yet). */
  uptimePct: number | null;
}

/** A scheduled maintenance window (v1 always empty — reserved on the wire). */
export interface PublicMaintenanceView {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
}

/** The public `GET /status/<slug>.json` snapshot (also the tRPC preview shape). */
export interface PublicStatusView {
  page: { slug: string; title: string };
  overall: PublicComponentStatus;
  components: PublicComponentView[];
  incidents: PublicIncidentView[];
  maintenance: PublicMaintenanceView[];
  generatedAt: string;
}

/** A pickable component candidate (live inventory + managed clusters + regions). */
export interface StatusComponentOption {
  kind: StatusPageComponentKind;
  ref: string;
  label: string;
  /** Extra picker context — stack name, engine, node count. Never secrets. */
  hint: string | null;
}

// ── Secrets manager (slice E1) — Docker secret families, versions, usage ──────

/** Label ON each managed Docker secret naming its family. */
export const SECRET_FAMILY_LABEL = 'swarmy.secret.family';
/** Label ON each managed Docker secret carrying its 1-based version number. */
export const SECRET_VERSION_LABEL = 'swarmy.secret.version';
/** Label ON each managed Docker secret naming the owning org. */
export const SECRET_ORG_LABEL = 'swarmy.secret.org';

/** Quick-create template suggestions — family NAMES only, never values. */
export const SECRET_NAME_TEMPLATES = [
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'OPENAI_API_KEY',
] as const;

/** One physical Docker secret version inside a family (`<family>__v<n>`). */
export interface SecretVersionView {
  version: number;
  /** Physical Docker secret name, `<family>__v<n>`. */
  name: string;
  createdAt: string;
  /** True for the family's newest version. */
  current: boolean;
  /** Service names whose spec references THIS physical version. */
  consumers: string[];
}

/** One live service consuming (any version of) a secret family. */
export interface SecretConsumerView {
  serviceId: string;
  serviceName: string;
  stack: string;
  /** The family version the service is pinned to. */
  version: number;
  /** True when pinned to the family's current version. */
  upToDate: boolean;
}

/** One secret family — grouped off `swarmy.secret.family` labels (Docker-truth). */
export interface SecretFamilyView {
  family: string;
  currentVersion: number;
  /** Newest first. */
  versions: SecretVersionView[];
  /** When the current version was created — i.e. the last rotation (or create). */
  lastRotatedAt: string;
  /** When v1 was created. */
  createdAt: string;
  consumers: SecretConsumerView[];
  /** Distinct consumer services (any version). */
  usedByCount: number;
  /** Consumers still pinned to an older version. */
  staleConsumers: number;
}

/** An unmanaged Docker secret (no swarmy labels) — surfaced read-only. */
export interface OrphanSecretView {
  id: string;
  name: string;
  createdAt: string;
  /** Service names referencing it (informational). */
  consumers: string[];
}

/** The whole Secrets page in one query. */
export interface SecretsListView {
  families: SecretFamilyView[];
  orphans: OrphanSecretView[];
}

/** create → always v1. The value is write-only and never echoed back. */
export interface CreateSecretResult {
  family: string;
  version: number;
  /** Physical Docker secret name created. */
  name: string;
}

/** rotate → v(n+1) + every consumer redeployed onto the new version. */
export interface RotateSecretResult {
  family: string;
  version: number;
  name: string;
  /** Service names that were redeployed (restarted) onto the new version. */
  redeployed: string[];
}

export interface AttachSecretResult {
  family: string;
  service: string;
  version: number;
  /** Stable in-container path (`/run/secrets/<family>`) — survives rotations. */
  mountPath: string;
  /** Env var set to the mount path, when requested. */
  envName: string | null;
}

export interface DetachSecretResult {
  family: string;
  service: string;
  detached: true;
}

export interface DeleteSecretFamilyResult {
  family: string;
  /** Version numbers whose physical secrets were removed. */
  removedVersions: number[];
}

export interface PruneSecretVersionsResult {
  family: string;
  /** Old, consumer-free versions that were removed. */
  removedVersions: number[];
  /** Old versions kept because a service still references them. */
  keptInUse: number[];
  currentVersion: number;
}

// ── Configs manager (slice E2) — Docker config families, content, apply ───────

/** Label ON each managed Docker config naming its family. */
export const CONFIG_FAMILY_LABEL = 'swarmy.config.family';
/** Label ON each managed Docker config carrying its 1-based version number. */
export const CONFIG_VERSION_LABEL = 'swarmy.config.version';
/** Label ON each managed Docker config naming the owning org. */
export const CONFIG_ORG_LABEL = 'swarmy.config.org';
/** Label ON each managed Docker config carrying the family's stable mount path. */
export const CONFIG_MOUNT_LABEL = 'swarmy.config.path';

/** Quick-create suggestions — family names + starter mount paths (never content). */
export const CONFIG_NAME_TEMPLATES = [
  { family: 'caddy-snippet', mountPath: '/etc/caddy/snippets/common.caddy' },
  { family: 'app-config', mountPath: '/etc/app/config.yaml' },
  { family: 'nginx-conf', mountPath: '/etc/nginx/conf.d/default.conf' },
] as const;

/** One physical Docker config version inside a family (`<family>__v<n>`). */
export interface ConfigVersionView {
  version: number;
  /** Physical Docker config name, `<family>__v<n>`. */
  name: string;
  createdAt: string;
  /** True for the family's newest version. */
  current: boolean;
  /** Service names whose spec references THIS physical version. */
  consumers: string[];
}

/** One live service consuming (any version of) a config family. */
export interface ConfigConsumerView {
  serviceId: string;
  serviceName: string;
  stack: string;
  /** The family version the service is pinned to. */
  version: number;
  /** True when pinned to the family's current (newest) version. */
  upToDate: boolean;
}

/** One config family — grouped off `swarmy.config.family` labels (Docker-truth). */
export interface ConfigFamilyView {
  family: string;
  currentVersion: number;
  /** Stable in-container path every consumer mounts the family at. */
  mountPath: string;
  /** Newest first. */
  versions: ConfigVersionView[];
  /** When the current version was created — i.e. the last edit (or create). */
  lastUpdatedAt: string;
  /** When v1 was created. */
  createdAt: string;
  consumers: ConfigConsumerView[];
  /** Distinct consumer services (any version). */
  usedByCount: number;
  /** Consumers still pinned to an older version. */
  staleConsumers: number;
}

/** An unmanaged Docker config (no swarmy labels) — surfaced read-only. */
export interface OrphanConfigView {
  id: string;
  name: string;
  createdAt: string;
  /** Service names referencing it (informational). */
  consumers: string[];
}

/** The whole Configs page in one query. */
export interface ConfigsListView {
  families: ConfigFamilyView[];
  orphans: OrphanConfigView[];
}

/** One version's decoded content (configs ARE readable, unlike secrets). */
export interface ConfigContentView {
  family: string;
  version: number;
  /** Physical Docker config name inspected. */
  name: string;
  /** UTF-8 decoded config contents. */
  content: string;
  mountPath: string;
  createdAt: string;
  /** True when this is the family's newest version. */
  current: boolean;
}

/** create → always v1. Nothing restarts until you attach/apply. */
export interface CreateConfigResult {
  family: string;
  version: number;
  /** Physical Docker config name created. */
  name: string;
  mountPath: string;
}

/** newVersion → v(n+1) created, NO consumer restarts (apply does that). */
export interface NewConfigVersionResult {
  family: string;
  version: number;
  name: string;
  /** The version that was current before this edit (diff/rollback anchor). */
  previousVersion: number;
}

/** Dry-run of apply: exactly who restarts when moving onto `targetVersion`. */
export interface ConfigRestartPreviewView {
  family: string;
  /** The version apply would move consumers onto (current when unspecified). */
  targetVersion: number;
  /** Consumers pinned to a different version — these WILL restart. */
  restarting: ConfigConsumerView[];
  /** Consumers already on the target version — untouched. */
  upToDate: ConfigConsumerView[];
}

/** apply → every consumer repointed at `version` (rollback when older). */
export interface ApplyConfigResult {
  family: string;
  version: number;
  /** Service names redeployed (restarted) onto the version. */
  redeployed: string[];
  /** Consumers already on the version — skipped, no restart. */
  skipped: string[];
  /** True when the applied version is older than the family's newest. */
  rollback: boolean;
}

export interface AttachConfigResult {
  family: string;
  service: string;
  version: number;
  /** Stable in-container path — survives edits and rollbacks. */
  mountPath: string;
}

export interface DetachConfigResult {
  family: string;
  service: string;
  detached: true;
}

export interface DeleteConfigFamilyResult {
  family: string;
  /** Version numbers whose physical configs were removed. */
  removedVersions: number[];
}

export interface PruneConfigVersionsResult {
  family: string;
  /** Old, consumer-free versions that were removed. */
  removedVersions: number[];
  /** Old versions kept because a service still references them. */
  keptInUse: number[];
  currentVersion: number;
}

// ── Exposure (slice E3) — public/private/managed audit of every service ───────

/** Exposure verdict; precedence: public-port > public-domain > internal-managed > private. */
export type ExposureKind = 'public-port' | 'public-domain' | 'private' | 'internal-managed';

/** Which managed-data family a service belongs to (`swarmy.<kind>.*` labels). */
export type ManagedDataKind = 'db' | 'cache' | 'search' | 'vector';

/** One published port on a service (world-reachable on every swarm node). */
export interface ExposedPortView {
  target: number;
  published: number;
  protocol: 'tcp' | 'udp';
  /** Publish mode when known (specs carry it; live inventory does not). */
  mode: 'ingress' | 'host' | null;
}

/** One service's exposure verdict for the audit table. */
export interface ExposureRowView {
  serviceId: string;
  serviceName: string;
  stack: string;
  exposure: ExposureKind;
  managedKind: ManagedDataKind | null;
  publishedPorts: ExposedPortView[];
  /** Hostnames from the service's `swarmy.ingress.routes` label. */
  domains: string[];
  /** Human-readable one-liners describing each public surface. */
  details: string[];
}

/** The org's exposure rule toggles (`ExposureConfig.rulesJson` + enforce). */
export interface ExposureRulesView {
  /** Forbid published ports on managed db/cache/search/vector services. */
  noPublicPortsOnManagedData: boolean;
  /** Forbid published UDP ports (deploy override = explicit approval). */
  noPublicUdp: boolean;
  /** Warn when a deploy publishes a port the live service didn't already publish. */
  warnOnNewPublishedPorts: boolean;
  /** "Block violating deploys" — when off, rules are advisory only. */
  enforce: boolean;
}

/** One live rule violation with a concrete fix hint. */
export interface ExposureViolationView {
  rule: string;
  severity: 'block' | 'warn';
  serviceId: string;
  serviceName: string;
  stack: string;
  message: string;
  /** Plain-English remediation ("remove published port 5432 — use private networking"). */
  fixHint: string;
}

/** The whole Exposure audit table in one query. */
export interface ExposureOverview {
  rows: ExposureRowView[];
  counts: { public: number; private: number; managed: number };
  auditedAt: string;
}

// ── Guardrails (slice E4) — production safety rules at deploy admission ───────

/** Every guardrail rule id, in display order. */
export const GUARDRAIL_RULE_IDS = [
  'noLatestTagInProd',
  'minDbReplicasProd',
  'requireBackupPolicy',
  'requireHealthcheck',
  'requireResourceLimits',
  'requireSignedImagesProd',
  'noPrivilegedContainers',
  'noHostPortsProd',
] as const;
export type GuardrailRuleId = (typeof GUARDRAIL_RULE_IDS)[number];

/** `block` refuses the deploy (admin override); `warn` refuses but any member may override. */
export type GuardrailSeverity = 'block' | 'warn';

/** One rule's configured state (an entry of `GuardrailConfig.rulesJson`). */
export interface GuardrailRuleView {
  id: GuardrailRuleId;
  enabled: boolean;
  severity: GuardrailSeverity;
  /** Numeric rule parameters (e.g. minDbReplicasProd: `{ n: 2 }`). */
  params: Record<string, number>;
  /** True when the rule only applies to production stacks (`swarmy.env=production`). */
  prodOnly: boolean;
}

/** The whole guardrail config: the production-safety master switch + per-rule state. */
export interface GuardrailsConfigView {
  /** ON ⇒ every rule is enforced at `block` severity on production stacks. */
  productionSafetyMode: boolean;
  rules: GuardrailRuleView[];
}

/** One live stack + its environment marking (the `swarmy.env` stack label). */
export interface StackEnvView {
  stack: string;
  production: boolean;
  serviceCount: number;
}

/** One violation inside a recorded admission decision. */
export interface GuardrailDecisionViolation {
  rule: string;
  severity: GuardrailSeverity;
  message: string;
  resource?: string;
}

/** One recent admission decision (blocked or overridden), read from the audit log. */
export interface GuardrailDecisionView {
  id: string;
  at: string;
  kind: 'blocked' | 'overridden';
  /** The raw audit action (e.g. `guardrails.deploy.blocked`, `stack.deploy.override`). */
  action: string;
  /** Display name of the human who hit the gate, when known. */
  actor: string | null;
  stack: string | null;
  violations: GuardrailDecisionViolation[];
}

// ── Audit pack (slice E5) — timeline, facets, export, retention ───────────────

/** Who performed an audited action. */
export type AuditActorKind = 'user' | 'apikey' | 'system' | 'agent';

/** One audit-log row projected for the timeline (metadata = full detail JSON). */
export interface AuditEntryView {
  /** BigInt row id as a decimal string (also the pagination cursor). */
  id: string;
  /** ISO timestamp of the action. */
  ts: string;
  actorType: AuditActorKind;
  actorId: string | null;
  /** Human label: user name/email, `API key <id>`, `swarmy`, `agent <node>`. */
  actorLabel: string;
  /** Dotted action name, e.g. `stack.deploy`, `secrets.rotate`. */
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

/** One page of the audit timeline (newest first). */
export interface AuditPageView {
  entries: AuditEntryView[];
  /** Pass back as `cursor` to fetch the next (older) page; null = end. */
  nextCursor: string | null;
}

/** A distinct actor seen in the log, for the filter dropdown. */
export interface AuditActorFacet {
  id: string;
  actorType: AuditActorKind;
  label: string;
}

/** Distinct values for the filter dropdowns (cached ~60s server-side). */
export interface AuditFacetsView {
  actions: string[];
  actorTypes: AuditActorKind[];
  actors: AuditActorFacet[];
}

/** A rendered export ready to download (CSV or JSON, capped at 10k rows). */
export interface AuditExportResult {
  format: 'csv' | 'json';
  filename: string;
  contentType: string;
  content: string;
  rowCount: number;
  /** True when the filter matched more rows than the export cap. */
  truncated: boolean;
}

/** The org's audit retention setting. */
export interface AuditRetentionView {
  days: number;
  /** True while the org has never overridden the default. */
  isDefault: boolean;
}

// ── Cost & capacity (slice F1) — node pricing, utilization, per-stack share ───

/** Where a node's utilization figures came from: live hub stats, recent
 *  MetricSample history, or nothing (node offline with no samples). */
export type CostUtilSource = 'live' | 'history' | 'none';

/** One node on the Cost page: its price label + capacity + utilization. */
export interface CostNodeView {
  nodeId: string;
  name: string;
  online: boolean;
  /** Monthly price (USD) from the `swarmy.node.cost` node label; null = unpriced. */
  monthlyUsd: number | null;
  cpuCores: number | null;
  memGb: number | null;
  cpuUtilPct: number | null;
  memUtilPct: number | null;
  utilSource: CostUtilSource;
}

/** One stack's estimated monthly cost (memory-share attribution — see cost.service). */
export interface CostStackView {
  stack: string;
  serviceCount: number;
  monthlyUsd: number;
  /** True when some of the stack's containers sit on unpriced nodes (estimate is a floor). */
  partial: boolean;
}

/** A service idling below the CPU threshold over the observation window. */
export interface CostIdleServiceView {
  serviceId: string;
  name: string;
  stack: string;
  avgCpuPct: number;
  /** Days of MetricSample history behind the average (0 = live snapshot only). */
  windowDays: number;
  /** This service's attributed monthly cost, when its nodes are priced. */
  estMonthlyUsd: number | null;
}

/** A node whose CPU and memory both averaged under the threshold for the window. */
export interface CostOversizedNodeView {
  nodeId: string;
  name: string;
  avgCpuPct: number;
  avgMemPct: number;
  monthlyUsd: number | null;
  windowDays: number;
}

/** Header totals for the Cost page. */
export interface CostTotalsView {
  /** Sum of every priced node's monthly cost. */
  monthlyUsd: number;
  pricedNodes: number;
  totalNodes: number;
  /** The share of monthlyUsd attributed to running stacks (rest = headroom/waste). */
  allocatedUsd: number;
  idleServiceCount: number;
}

/** The whole Cost overview in one query. */
export interface CostOverviewView {
  totals: CostTotalsView;
  nodes: CostNodeView[];
  stacks: CostStackView[];
  idleServices: CostIdleServiceView[];
  oversizedNodes: CostOversizedNodeView[];
  generatedAt: string;
}

/** Storage footprint: Garage buckets (A4) + registered cluster volumes. */
export interface CostStorageView {
  /** Garage store state (mirrors BucketStoreState; 'disabled' when never enabled). */
  garageState: string;
  bucketCount: number;
  objectCount: number;
  usageBytes: number;
  volumeCount: number;
}

export type CostRecommendationKind =
  | 'unpriced-node'
  | 'oversized-node'
  | 'idle-service'
  | 'offline-node';

/** One human-readable saving/setup nudge on the recommendations feed. */
export interface CostRecommendationView {
  /** Stable id — the dismiss key the UI persists in localStorage. */
  id: string;
  kind: CostRecommendationKind;
  /** Display resource ("node wkr-3", "service worker"). */
  resource: string;
  message: string;
  /** Rough monthly saving guess (USD); null for setup nudges. */
  savingsUsd: number | null;
}

// ── Resilience (slice F2) — readiness score, posture problems, safe drills ────

export type ResilienceSeverity = 'crit' | 'warn' | 'info';

/** The stable check families the resilience audit runs. */
export type ResilienceCheckId =
  | 'single-replica'
  | 'cache-no-replica'
  | 'db-topology'
  | 'storage-replication'
  | 'backup-recency'
  | 'restore-untested'
  | 'ingress-single'
  | 'geodns-single-region'
  | 'controller-backup';

/** One posture problem with a severity and a link to the page that fixes it. */
export interface ResilienceProblemView {
  /** Stable id, e.g. `db-topology/shop/main` (dedupe + list key). */
  id: string;
  check: ResilienceCheckId;
  severity: ResilienceSeverity;
  title: string;
  detail: string;
  fixHint: string;
  /** SPA path of the page where this gets fixed (e.g. `/backups`). */
  fixPath: string;
  /** Label for the fix link ("Add a replica"). */
  fixLabel: string;
  /** The affected resource(s), display form ("shop/main", "grafana, loki"). */
  resource: string | null;
}

export type ResilienceGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Score = 100 − Σ severity weights (crit 15, warn 7, info 2), floored at 0. */
export interface ResilienceScoreView {
  score: number;
  grade: ResilienceGrade;
  /** "Production readiness: NN%". */
  headline: string;
  counts: { crit: number; warn: number; info: number };
  /** How many check families ran (problems or not). */
  checksRun: number;
  problems: ResilienceProblemView[];
  generatedAt: string;
}

export type ResilienceDrillKind = 'restore' | 'failover' | 'backup-verify';
export type ResilienceDrillStatus = 'passed' | 'failed';

/** One step of a drill run (shown in the run detail / history). */
export interface ResilienceDrillStepView {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string | null;
  durationMs: number | null;
}

/** The recorded outcome of one drill run (persisted as an audit-log row). */
export interface ResilienceDrillResultView {
  kind: ResilienceDrillKind;
  status: ResilienceDrillStatus;
  /** ISO time the drill finished. */
  at: string;
  durationMs: number;
  /** Drill target, display form ("shop/main", target name) or null. */
  target: string | null;
  summary: string;
  steps: ResilienceDrillStepView[];
  error: string | null;
}

/** One drill card on the Resilience page: last outcome + derived RPO/RTO. */
export interface ResilienceDrillCardView {
  kind: ResilienceDrillKind;
  /** Whether the drill can run right now. */
  available: boolean;
  /** Why not, when `available` is false (null when runnable). */
  unavailableReason: string | null;
  last: ResilienceDrillResultView | null;
  /** Age of the latest successful backup in seconds (the RPO), or null. */
  rpoSeconds: number | null;
  /** Duration of the last successful restore drill in ms (the RTO estimate). */
  rtoEstimateMs: number | null;
}

/** A DB cluster the drills can target. */
export interface ResilienceDrillTargetView {
  stack: string;
  cluster: string;
  topology: string;
  /** Primary running and (for failover) at least one replica running. */
  healthy: boolean;
  /** Running replica count (failover needs ≥1). */
  replicasRunning: number;
}

/** The whole Resilience page in one query. */
export interface ResilienceOverviewView {
  ready: true;
  score: ResilienceScoreView;
  drills: ResilienceDrillCardView[];
  drillTargets: ResilienceDrillTargetView[];
}

// ── Blueprints (slice F3) — the parameterized app catalog ─────────────────────

/** Catalog ids, in gallery order. */
export const BLUEPRINT_IDS = [
  'node-api',
  'nextjs-app',
  'static-site',
  'wordpress',
  'n8n',
  'directus',
  'worker-with-queue',
  'meilisearch-app',
  'monitoring-notes',
] as const;
export type BlueprintId = (typeof BLUEPRINT_IDS)[number];

/** T-shirt size → replica/memory presets resolved by the catalog. */
export const BLUEPRINT_SIZES = ['s', 'm', 'l'] as const;
export type BlueprintSize = (typeof BLUEPRINT_SIZES)[number];

/** The step kinds a blueprint plan may emit (each maps to an existing service). */
export const BLUEPRINT_STEP_KINDS = [
  'db.provision',
  'cache.provision',
  'bucket',
  'secret',
  'stack.deploy',
  'ingress.route',
] as const;
export type BlueprintStepKind = (typeof BLUEPRINT_STEP_KINDS)[number];

/** One per-blueprint option descriptor — drives the wizard's generic form. */
export interface BlueprintOptionView {
  key: string;
  label: string;
  kind: 'string' | 'boolean';
  /** One-line helper rendered under the field. */
  help?: string;
  placeholder?: string;
  defaultValue: string | boolean;
}

/** Gallery card metadata for one blueprint. */
export interface BlueprintMetaView {
  id: BlueprintId;
  name: string;
  tagline: string;
  category: 'app' | 'cms' | 'automation' | 'data' | 'docs';
  /** Human resource chips ("Postgres", "Cache", "Route") shown on the card. */
  resources: string[];
  /** Doc-only cards link elsewhere instead of opening the deploy wizard. */
  docOnly: boolean;
  /** Whether the domain param unlocks an ingress-route step. */
  supportsDomain: boolean;
  options: BlueprintOptionView[];
}

/** One planned step (dry-run preview). Detail values are display-safe strings. */
export interface BlueprintPlanStepView {
  kind: BlueprintStepKind;
  label: string;
  /** Display-safe key facts, e.g. { service: 'blog-app', host: 'blog.example.com' }. */
  detail: Record<string, string>;
}

/** The dry-run preview the wizard shows before deploying. */
export interface BlueprintPlanView {
  id: BlueprintId;
  stackName: string;
  /** "Will create: Postgres cluster db, stack blog (2 services), route …". */
  summary: string;
  steps: BlueprintPlanStepView[];
}

export type BlueprintStepStatus = 'succeeded' | 'failed' | 'skipped';

/** One executed step's outcome (returned synchronously by deploy). */
export interface BlueprintStepResultView {
  kind: BlueprintStepKind;
  label: string;
  status: BlueprintStepStatus;
  /** One-line human outcome; never contains a credential. */
  detail: string | null;
  error: string | null;
}

/** The whole deploy outcome, step by step. */
export interface BlueprintDeployResultView {
  id: BlueprintId;
  stackName: string;
  ok: boolean;
  steps: BlueprintStepResultView[];
  /** Public URL when a route step landed (`https://<domain>`). */
  url: string | null;
  /**
   * One-time reveals (e.g. a generated admin password). Shown ONCE in the deploy
   * result and never retrievable again — mirrors the cache-provision pattern.
   */
  notes: string[];
}

// ── Managed search (slice F4) — views over Docker-truth `swarmy.search.*` labels ──
import type { InvServiceStatus as SearchServiceStatus } from './inventory';

/** Supported managed search engines (meilisearch is the default). */
export const SEARCH_ENGINES = ['meilisearch', 'typesense'] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

/**
 * A live stats sample from the engine (`/stats` for meilisearch, `/collections`
 * + `/metrics.json` for typesense). Also the JSON payload of the
 * `swarmy.search.stats` label the search-reconcile worker stamps each tick.
 */
export interface SearchStatsView {
  /** Total documents across all indexes/collections. */
  docs: number;
  /** Index (meilisearch) / collection (typesense) count. */
  indexes: number;
  /** On-disk database size in bytes (meilisearch `databaseSize`), or null. */
  dbSizeBytes: number | null;
  /** Resident memory used by the engine in bytes (typesense), or null. */
  memoryBytes: number | null;
  /** ISO time the sample was taken. */
  at: string;
}

/** An app service wired to the instance (`swarmy.search.inject` labels). */
export interface SearchAttachmentView {
  service: string;
  /** The host env var injected (MEILI_HOST or TYPESENSE_HOST). */
  envVar: string;
}

/** One managed search instance, projected straight off the live inventory. */
export interface SearchInstanceView {
  stack: string;
  name: string;
  engine: SearchEngine;
  /** The swarm service backing the instance (`<stack>_<name>-search`). */
  service: string;
  status: SearchServiceStatus | 'absent';
  desired: number;
  running: number;
  /** Swarm DNS host apps connect to (the service name). */
  host: string;
  /** 7700 (meilisearch) or 8108 (typesense). */
  port: number;
  /** `http://<host>:<port>` — private-only, reachable on the instance network. */
  url: string;
  /** Docker secret name carrying the master/API key (value never returned). */
  keySecret: string;
  /** Last stats stamp (`swarmy.search.stats`), or null before the first sample. */
  stats: SearchStatsView | null;
  attachments: SearchAttachmentView[];
}

/** One search snapshot in the restic catalog (tag `search:<stack>_<name>`). */
export interface SearchBackupView {
  id: string;
  time: string;
  /** Stringified bytes (BigInt-safe), or null when restic omitted a size. */
  sizeBytes: string | null;
  tags: string[];
}

/** Returned ONCE by search.provision — the master key is not retrievable later. */
export interface SearchProvisionResult {
  stack: string;
  name: string;
  engine: SearchEngine;
  host: string;
  port: number;
  url: string;
  keySecret: string;
  /** Generated master/API key; surfaced once, stored only as a Docker secret. */
  masterKey: string;
}

// ── AI gateway (slice F5) — provider config, virtual keys, usage, request log ──
import type { InvServiceStatus as VectorServiceStatus } from './inventory';

/** Supported gateway providers (route target for a model prefix). */
export const AI_PROVIDER_KINDS = ['anthropic', 'openai', 'custom'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/** One configured upstream provider. The API key itself is NEVER returned. */
export interface AiProviderView {
  kind: AiProviderKind;
  /** Override base URL (required for `custom`, optional otherwise). */
  baseUrl: string | null;
  /** Whether an API key is stored (vault-encrypted) for this provider. */
  hasKey: boolean;
  /** Models without a known claude/gpt/o-series prefix route here when true. */
  isDefault: boolean;
}

/** Org-level gateway toggles. */
export interface AiSettingsView {
  /** Write an AiRequestLog row (redacted prompt) per request. */
  auditLog: boolean;
  /** Exact-body-match response cache (non-streaming, 5 min TTL). */
  cache: boolean;
}

export interface AiProvidersView {
  providers: AiProviderView[];
  /** `<controller>/ai/v1` — the base URL apps call with a virtual key. */
  gatewayUrl: string;
}

/** Result of the provider "Test" button (one cheap upstream request). */
export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  /** Model pinged, or the endpoint probed. */
  target: string;
  message: string | null;
}

export interface AiKeyLimitsView {
  /** Requests per minute (sliding window), or null = unlimited. */
  rpm: number | null;
  /** Daily budget in USD, or null = unlimited. */
  dailyBudgetUsd: number | null;
}

/** One virtual key row (the key itself is stored only as a sha-256 hash). */
export interface AiKeyView {
  id: string;
  name: string;
  /** Optional app/service this key was minted for (`<stack>/<service>`). */
  appRef: string | null;
  disabled: boolean;
  createdAt: string;
  limits: AiKeyLimitsView;
  /** Rolling 30-day usage for the keys table. Cost is an ESTIMATE. */
  usage30d: { requests: number; costUsd: number };
}

/** Returned ONCE by ai.mintKey — the plaintext key is never retrievable later. */
export interface AiKeyMintResult {
  id: string;
  name: string;
  /** `swk-ai-…` — show once, then it exists only as a hash. */
  key: string;
  gatewayUrl: string;
}

/** One day bucket of usage (UTC days). Cost is an ESTIMATE from a static table. */
export interface AiUsageDayView {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  requests: number;
  inTokens: number;
  outTokens: number;
  costUsd: number;
}

/** Per-model / per-key aggregate row. */
export interface AiUsageBreakdownRow {
  key: string;
  requests: number;
  inTokens: number;
  outTokens: number;
  costUsd: number;
}

export interface AiUsageSummaryView {
  days: AiUsageDayView[];
  byModel: AiUsageBreakdownRow[];
  byKey: AiUsageBreakdownRow[];
  totals: {
    requests: number;
    inTokens: number;
    outTokens: number;
    costUsd: number;
    cacheHits: number;
    avgLatencyMs: number;
  };
  /** Costs come from a static $/MTok table — always an estimate. */
  costIsEstimate: true;
}

/** One request-log row (only written when the audit toggle is on). */
export interface AiRequestLogView {
  id: string;
  at: string;
  keyName: string;
  model: string;
  provider: string;
  status: string;
  latencyMs: number;
  inTokens: number;
  outTokens: number;
  costUsd: number;
  cacheHit: boolean;
  /** First 200 chars of the prompt, or null when unavailable. */
  promptRedacted: string | null;
}

/** Result of wiring an app service to the gateway (key rides a Docker secret). */
export interface AiAttachResult {
  appService: string;
  keyName: string;
  gatewayUrl: string;
  /** Env var carrying the gateway base URL (`AI_GATEWAY_URL`). */
  envVar: string;
  /** Env var pointing at the mounted key file (`AI_GATEWAY_KEY_FILE`). */
  keyFileVar: string;
  /** Docker secret name carrying the virtual key (value never returned). */
  keySecret: string;
}

// ── Vector store (slice F5) — Qdrant + pgvector over `swarmy.vector.*` labels ──

/** Live sample from qdrant `GET /collections` (also the stats label payload). */
export interface VectorStatsView {
  collections: number;
  collectionNames: string[];
  /** ISO time the sample was taken. */
  at: string;
}

/** An app service wired to the instance (`swarmy.vector.inject` labels). */
export interface VectorAttachmentView {
  service: string;
  /** The URL env var injected (default QDRANT_URL). */
  envVar: string;
}

/** One managed qdrant instance, projected straight off the live inventory. */
export interface VectorInstanceView {
  stack: string;
  name: string;
  kind: 'qdrant';
  /** The swarm service backing the instance (`<stack>_<name>-vector`). */
  service: string;
  status: VectorServiceStatus | 'absent';
  desired: number;
  running: number;
  /** Swarm DNS host apps connect to (the service name). */
  host: string;
  /** 6333 (qdrant HTTP API). */
  port: number;
  /** `http://<host>:<port>` — private-only, reachable on the instance network. */
  url: string;
  /** Docker secret name carrying the API key (value never returned). */
  keySecret: string;
  /** Last stats stamp (`swarmy.vector.stats`), or null before the first sample. */
  stats: VectorStatsView | null;
  attachments: VectorAttachmentView[];
}

/** Returned ONCE by vector.provision — the API key is not retrievable later. */
export interface VectorProvisionResult {
  stack: string;
  name: string;
  host: string;
  port: number;
  url: string;
  keySecret: string;
  /** Generated API key; surfaced once, stored only as a Docker secret. */
  apiKey: string;
}

/** A managed Postgres cluster on the pgvector enablement card. */
export interface PgvectorClusterView {
  stack: string;
  cluster: string;
  /** The cluster primary service (where `CREATE EXTENSION` runs). */
  primaryService: string;
  status: VectorServiceStatus | 'absent';
  /** `swarmy.vector.pgvector=true` stamped on the primary. */
  enabled: boolean;
}

// ── Notifications (slice F6) — email provider config, templates, delivery log ──

/** Email providers the notification relay can deliver through. */
export const NOTIFY_PROVIDERS = ['smtp', 'resend', 'postmark', 'mailgun'] as const;
export type NotifyProviderView = (typeof NOTIFY_PROVIDERS)[number];

/** Lifecycle of one queued email (mirrors `NotificationDeliveryStatus`). */
export const NOTIFY_DELIVERY_STATUSES = ['queued', 'sent', 'failed', 'bounced'] as const;
export type NotifyDeliveryStatusView = (typeof NOTIFY_DELIVERY_STATUSES)[number];

/**
 * The org's email provider config. Credentials stay vault-encrypted server-side;
 * only redacted, non-secret connection facts ride to the browser.
 */
export interface NotifyConfigView {
  provider: NotifyProviderView;
  fromAddress: string | null;
  /** True once credentials are stored (they are never returned). */
  configured: boolean;
  /** Non-secret connection facts (smtp host/port/user, mailgun domain, …). */
  summary: Record<string, string>;
  /**
   * Public URL of the auto-created inbound endpoint that receives provider
   * bounce webhooks (point Resend/Postmark/Mailgun bounce hooks here), or null
   * until the provider is configured.
   */
  bounceEndpointUrl: string | null;
  updatedAt: string | null;
}

/** One reusable email template (`{{var}}` placeholders in subject + bodies). */
export interface NotifyTemplateView {
  id: string;
  name: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row of the delivery log. */
export interface NotifyDeliveryView {
  id: string;
  to: string;
  subject: string | null;
  status: NotifyDeliveryStatusView;
  /** Provider message id (set once sent; how bounces map back). */
  providerId: string | null;
  error: string | null;
  /** Send attempts made so far (retries with backoff, ≤4 total). */
  attempts: number;
  /** Template name the body was rendered from, or null for direct sends. */
  template: string | null;
  createdAt: string;
}

export interface NotifyDeliveriesPage {
  deliveries: NotifyDeliveryView[];
  nextCursor: string | null;
}

/** Hero counts for Settings · Notifications. */
export interface NotifyOverview {
  configured: boolean;
  provider: NotifyProviderView | null;
  queued: number;
  sent24h: number;
  failed24h: number;
  bounced24h: number;
  templates: number;
}

/** Result of a test send (the delivery is queued, not sent inline). */
export interface NotifyTestSendResult {
  queued: true;
  to: string;
  deliveryId: string;
}

// ── Canary rollouts (slice D2) — weighted Caddy routes + label-driven state ───

/** RED aggregate for one side of a canary (null until telemetry has data). */
export interface CanaryRedView {
  /** Error rate as a percentage (0–100), from ClickHouse entry spans. */
  errorRatePct: number | null;
  p95Ms: number | null;
}

/**
 * One in-flight canary, read entirely from Docker labels
 * (`swarmy.canary.of` + `swarmy.canary.params` on the `<svc>--canary` service)
 * and the live inventory — never the DB.
 */
export interface CanaryRunView {
  stack: string;
  /** Stable service Docker name (e.g. `storefront_web`). */
  service: string;
  /** The `<svc>--canary` sibling carrying the new image. */
  canaryService: string;
  stableImage: string;
  canaryImage: string;
  /** Share of ingress traffic routed to the canary (0–100). */
  trafficPct: number;
  /** Watch window; the deploy-canary worker promotes after it elapses clean. */
  durationMin: number;
  /** Error-rate ceiling (percent) that triggers auto-rollback; null = off. */
  rollbackOnErrorRatePct: number | null;
  startedAt: string;
  elapsedMin: number;
  /** Minutes left in the watch window (0 once promotion is due). */
  remainingMin: number;
  /** Hosts whose routes carry the weighted canary upstream. */
  routedHosts: string[];
  stableReplicas: { desired: number; running: number };
  canaryReplicas: { desired: number; running: number };
  stableRed: CanaryRedView;
  canaryRed: CanaryRedView;
}

/** Result of a manual promote — the stable service now runs the canary image. */
export interface CanaryPromoteResult {
  service: string;
  image: string;
}

/** Result of a manual abort — the canary is gone and traffic is 100% stable. */
export interface CanaryAbortResult {
  service: string;
}

// ── Managed-DB replication telemetry (slice A2 pitr-ha) — appended, additive ──

/**
 * One live member of a managed Postgres cluster, with the Docker-truth role and
 * the replication telemetry the manageddb-reconcile worker stamps as labels
 * (`swarmy.db.lag.<member>` seconds + `swarmy.db.leader`). Canonical shape for
 * `manageddb.service#DbMemberView` and the db-cluster-panel member rows.
 */
export interface DbClusterMemberView {
  service: string;
  role: 'primary' | 'replica' | 'dcs';
  /** geo: the region a replica sibling is pinned to / the primary's write-region. */
  region?: string;
  status: 'running' | 'degraded' | 'deploying' | 'idle' | 'stopped' | 'absent';
  desired: number;
  running: number;
  /**
   * Replication lag behind the writer in seconds (from
   * `pg_last_xact_replay_timestamp()`), stamped by the reconcile each tick.
   * Absent = not measured yet (primary itself, exec disabled, or member down).
   */
  lagSeconds?: number;
}

/** The per-cluster wal-shipper sidecar (PITR WAL archiving), when provisioned. */
export interface DbWalShipperView {
  service: string;
  status: 'running' | 'degraded' | 'deploying' | 'idle' | 'stopped' | 'absent';
}

/** Replica lag above this reads as "falling behind" (amber) in the dashboard. */
export const DB_LAG_WARN_SECONDS = 10;

// ── PR preview environments (slice D4) — appended, additive ──────────────────

/** Aggregate status of a preview stack, derived from its live services. */
export type PreviewStatusView = 'running' | 'deploying' | 'degraded' | 'stopped';

/**
 * One live PR preview environment. Pure Docker-truth: assembled from the
 * `swarmy.preview.*` labels the previews service stamps on every service of a
 * `pr<N>-<repo-short>` stack — nothing is persisted in the DB.
 */
export interface PreviewView {
  /** Docker stack namespace of the preview (`pr142-shop`) — its stable id. */
  stack: string;
  /** Repo short-name (`shop`) the preview was built from. */
  repo: string;
  /** Pull-request / merge-request number (manual previews use a pseudo-number). */
  pr: number;
  branch: string;
  /** Public URL (`https://pr-142.preview.example.com`), when a base domain is set. */
  url: string | null;
  /** ISO timestamp of the last deploy (opened or synchronize refreshes it). */
  createdAt: string | null;
  /** TTL in hours from `createdAt`; 0 = never expires. */
  ttlHours: number;
  /** ISO expiry the reconcile worker tears down after; null = no TTL. */
  expiresAt: string | null;
  serviceCount: number;
  runningServices: number;
  status: PreviewStatusView;
}

/** Per-repo preview settings (`GitRepo.previewsJson` — repo INPUT config). */
export interface PreviewSettingsView {
  enabled: boolean;
  /** Previews publish at `pr-<N>.<baseDomain>`; empty = no ingress route. */
  baseDomain: string;
  /** Hours a preview lives after its last deploy; 0 = never expires. */
  ttlHours: number;
  /** Tear the preview down when the PR closes/merges (recommended). */
  teardownOnClose: boolean;
}
