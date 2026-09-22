/**
 * Swarm `ServiceSpec`s for the swarmy-managed observability stack: a single
 * ClickHouse store + an OTel Collector gateway. These are plain specs handed to
 * the EXISTING `service.deploy` dispatch path — no new agent code, no new
 * protocol. Pinned images keep deploys reproducible.
 *
 * ZERO host files: the rendered collector config + ClickHouse init DDL ride as
 * swarm Docker CONFIGS (replicated by the managers to whichever node a task
 * lands on), never bind mounts. Bind mounts needed the file on every node the
 * task might schedule to — and a containerised agent wrote them into its own
 * filesystem, not the host — so the tasks were rejected forever. Config names
 * are content-addressed (`<service>-<sha8>`): a changed render is a new config
 * + a service update, and superseded configs are swept after the update.
 *
 * SECRETS NEVER RIDE IN A CONFIG: Docker configs are readable by anyone with
 * `docker config inspect` on a manager. The ClickHouse password is a Docker
 * SECRET (content-addressed `swarmy-clickhouse-password-<sha8>`, mounted at
 * `/run/secrets/clickhouse-password`): ClickHouse reads it via
 * `CLICKHOUSE_PASSWORD_FILE`, the collector config references it via
 * `${file:/run/secrets/clickhouse-password}`. No plaintext env either.
 */
import { createHash } from 'node:crypto';
import { STACK_LABEL, SYSTEM_STACK, SYSTEM_STACK_LABEL } from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import {
  CLICKHOUSE_INIT_PATH,
  COLLECTOR_CONFIG_PATH,
  renderClickhouseInitSql,
  renderCollectorConfig,
} from './observability-render';

/** The overlay network apps' OTLP env points at (`otel-collector:4317`). */
export const OTEL_OVERLAY_NETWORK = 'swarmy';

/** Stable name the collector exporter + the read DSN use for ClickHouse. */
export const CLICKHOUSE_SERVICE_HOST = 'swarmy-clickhouse';

/** ClickHouse HTTP interface port (used for both reads and the DSN). */
export const CLICKHOUSE_HTTP_PORT = 8123;
/** ClickHouse native port (collector exporter target). */
export const CLICKHOUSE_NATIVE_PORT = 9000;

/** OTLP gRPC / HTTP receiver ports on the collector. */
export const OTLP_GRPC_PORT = 4317;
export const OTLP_HTTP_PORT = 4318;

const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.8-alpine';
const COLLECTOR_IMAGE = 'otel/opentelemetry-collector-contrib:0.111.0';

const MANAGED_LABELS: Record<string, string> = {
  'swarmy.managed': 'true',
  'swarmy.component': 'observability',
  // Group under the swarmy-system stack namespace (platform plumbing, not a
  // user app stack) and mark it so the UI can tell system stacks apart.
  [STACK_LABEL]: SYSTEM_STACK,
  [SYSTEM_STACK_LABEL]: 'true',
};

/** Service names (also the prefixes of their content-addressed configs). */
export const CLICKHOUSE_SERVICE = 'swarmy-clickhouse';
export const COLLECTOR_SERVICE = 'swarmy-otel-collector';
/** Config-name prefixes: `<prefix>-<sha8>`. */
export const COLLECTOR_CONFIG_PREFIX = `${COLLECTOR_SERVICE}-config`;
export const CLICKHOUSE_INIT_CONFIG_PREFIX = `${CLICKHOUSE_SERVICE}-init`;
/** Label marking a Docker config as part of the observability stack (sweep scope). */
export const OBS_CONFIG_LABEL = 'swarmy.observability.config';
/** Label marking a Docker secret as part of the observability stack (sweep scope). */
export const OBS_SECRET_LABEL = 'swarmy.observability.secret';
/** Secret-name prefix for the ClickHouse password: `<prefix>-<sha8>`. */
export const CLICKHOUSE_PASSWORD_SECRET_PREFIX = `${CLICKHOUSE_SERVICE}-password`;
/** In-container secret file name (under `/run/secrets/`) — stable across rotations. */
export const CLICKHOUSE_PASSWORD_TARGET = 'clickhouse-password';
/** Absolute in-container path of the mounted ClickHouse password secret. */
export const CLICKHOUSE_PASSWORD_FILE = `/run/secrets/${CLICKHOUSE_PASSWORD_TARGET}`;
/**
 * Label on the ClickHouse service recording the Docker SWARM node id it is
 * pinned to. Its data lives on a node-local named volume, so a reschedule to
 * another node would silently start from an empty store — the pin (read back
 * from the live service on every redeploy) keeps it put.
 */
export const CLICKHOUSE_NODE_LABEL = 'swarmy.observability.node';

/** Named volume holding the ClickHouse data (node-local). */
const CLICKHOUSE_DATA_VOLUME = 'swarmy-clickhouse-data';

/** Content-addressed config name: `<prefix>-<first 8 hex of sha256(contents)>`. */
export function contentConfigName(prefix: string, contents: string): string {
  return `${prefix}-${createHash('sha256').update(contents, 'utf8').digest('hex').slice(0, 8)}`;
}

/** One rendered Docker config the deploy path must `config.create` first. */
export interface ObservabilityConfigObject {
  name: string;
  contents: string;
  /** In-container mount path. */
  target: string;
}

/**
 * One Docker SECRET the deploy path must `secret.create` first. `value` is the
 * plaintext (base64'd onto the wire, straight into the Docker API — never a
 * config, label, env, or log line).
 */
export interface ObservabilitySecretObject {
  name: string;
  value: string;
  /** File name under `/run/secrets/`. */
  target: string;
}

export interface ObservabilityConfigSet {
  collector: ObservabilityConfigObject;
  clickhouseInit: ObservabilityConfigObject;
  /** The ClickHouse password as a Docker secret (shared by store + collector). */
  clickhousePassword: ObservabilitySecretObject;
}

/**
 * The rendered Docker configs + secret the deploy path creates (idempotently —
 * same content ⇒ same name) BEFORE deploying the specs that reference them.
 * The configs carry NO secret material; the password rides only in the secret
 * (content-addressed, so a rotated password is a new secret + service update).
 */
export function observabilityConfigs(opts: {
  password: string;
  retentionDays: number;
  database?: string;
}): ObservabilityConfigSet {
  const database = opts.database ?? 'otel';
  const initSql = renderClickhouseInitSql({ database, retentionDays: opts.retentionDays });
  const collectorYaml = renderCollectorConfig({
    clickhouseHost: CLICKHOUSE_SERVICE_HOST,
    clickhouseUser: 'default',
    clickhousePasswordFile: CLICKHOUSE_PASSWORD_FILE,
    clickhouseDatabase: database,
    retentionDays: opts.retentionDays,
  });
  return {
    collector: {
      name: contentConfigName(COLLECTOR_CONFIG_PREFIX, collectorYaml),
      contents: collectorYaml,
      target: COLLECTOR_CONFIG_PATH,
    },
    clickhouseInit: {
      name: contentConfigName(CLICKHOUSE_INIT_CONFIG_PREFIX, initSql),
      contents: initSql,
      target: CLICKHOUSE_INIT_PATH,
    },
    clickhousePassword: {
      name: contentConfigName(CLICKHOUSE_PASSWORD_SECRET_PREFIX, opts.password),
      value: opts.password,
      target: CLICKHOUSE_PASSWORD_TARGET,
    },
  };
}

/**
 * Observability configs that are safe to remove: carry our prefix, are not in
 * the keep set, and no live service still references them. Pure.
 */
export function staleObservabilityConfigs(
  existing: readonly string[],
  keep: readonly string[],
  referenced: readonly string[] = [],
): string[] {
  const keepSet = new Set([...keep, ...referenced]);
  return existing.filter(
    (n) =>
      (n.startsWith(`${COLLECTOR_CONFIG_PREFIX}-`) || n.startsWith(`${CLICKHOUSE_INIT_CONFIG_PREFIX}-`)) &&
      !keepSet.has(n),
  );
}

/**
 * Observability secrets safe to remove: carry our prefix, are not kept, and no
 * live service still references them. Pure.
 */
export function staleObservabilitySecrets(
  existing: readonly string[],
  keep: readonly string[],
  referenced: readonly string[] = [],
): string[] {
  const keepSet = new Set([...keep, ...referenced]);
  return existing.filter(
    (n) => n.startsWith(`${CLICKHOUSE_PASSWORD_SECRET_PREFIX}-`) && !keepSet.has(n),
  );
}

export interface StorePinInput {
  /** `swarmy.observability.node` off the live ClickHouse service, if deployed. */
  labelled?: string;
  /** Swarm node id of the manager the deploy is dispatched through. */
  managerSwarmNodeId?: string;
  /** Swarm node ids currently known for the org (includes offline). */
  knownSwarmNodeIds: ReadonlySet<string>;
}

/**
 * Where the ClickHouse store is pinned. Pure.
 *  1. An existing pin label that still names a known swarm node wins — the data
 *     volume lives there, so the store never drifts (even while that node is
 *     briefly offline: `includeOffline` inventory keeps it known).
 *  2. Otherwise pin to the manager the deploy is dispatched through.
 *  3. Unresolvable ⇒ undefined (no constraint rather than an unsatisfiable one).
 */
export function resolveStorePin(input: StorePinInput): string | undefined {
  if (input.labelled && input.knownSwarmNodeIds.has(input.labelled)) return input.labelled;
  return input.managerSwarmNodeId || undefined;
}

/** Secret ref mounting the ClickHouse password at {@link CLICKHOUSE_PASSWORD_FILE}. */
function passwordSecretRef(secret: string) {
  // 0444: the collector image runs as a non-root uid; the file only exists on
  // the task's in-memory secrets tmpfs.
  return { source: secret, target: CLICKHOUSE_PASSWORD_TARGET, mode: 0o444 };
}

export function clickhouseServiceSpec(opts: {
  /** Content-addressed Docker SECRET carrying the password ({@link ObservabilityConfigSet}). */
  passwordSecret: string;
  retentionDays: number;
  /** Content-addressed Docker config carrying the init DDL. */
  initConfig: string;
  /** Docker SWARM node id to pin to (data volume is node-local). */
  pinSwarmNodeId?: string;
}): ServiceSpec {
  return {
    name: CLICKHOUSE_SERVICE,
    image: CLICKHOUSE_IMAGE,
    mode: { replicated: { replicas: 1 } },
    labels: {
      ...MANAGED_LABELS,
      'swarmy.role': 'store',
      ...(opts.pinSwarmNodeId ? { [CLICKHOUSE_NODE_LABEL]: opts.pinSwarmNodeId } : {}),
    },
    env: {
      CLICKHOUSE_USER: 'default',
      // The entrypoint reads the password from the mounted secret file.
      CLICKHOUSE_PASSWORD_FILE: CLICKHOUSE_PASSWORD_FILE,
      CLICKHOUSE_DB: 'otel',
      // Surfaced for the init DDL / TTL setup; harmless otherwise.
      SWARMY_RETENTION_DAYS: String(opts.retentionDays),
    },
    ports: [
      { target: CLICKHOUSE_HTTP_PORT, protocol: 'tcp', mode: 'ingress' },
      { target: CLICKHOUSE_NATIVE_PORT, protocol: 'tcp', mode: 'ingress' },
    ],
    mounts: [{ type: 'volume', source: CLICKHOUSE_DATA_VOLUME, target: '/var/lib/clickhouse' }],
    // Init DDL runs on first boot from the entrypoint dir.
    configs: [{ source: opts.initConfig, target: CLICKHOUSE_INIT_PATH, mode: 0o444 }],
    secrets: [passwordSecretRef(opts.passwordSecret)],
    ...(opts.pinSwarmNodeId
      ? { placement: { constraints: [`node.id==${opts.pinSwarmNodeId}`] } }
      : {}),
    networks: [OTEL_OVERLAY_NETWORK],
  };
}

export function collectorServiceSpec(opts: {
  /** Content-addressed Docker SECRET carrying the ClickHouse password. */
  passwordSecret: string;
  /** Content-addressed Docker config carrying the collector `config.yaml`. */
  config: string;
}): ServiceSpec {
  return {
    name: COLLECTOR_SERVICE,
    image: COLLECTOR_IMAGE,
    mode: { replicated: { replicas: 1 } },
    labels: { ...MANAGED_LABELS, 'swarmy.role': 'collector' },
    args: ['--config', COLLECTOR_CONFIG_PATH],
    env: {
      // Reference / debugging only — host:port, NEVER credentials (the old
      // full DSN leaked the password into `docker service inspect`).
      CLICKHOUSE_ENDPOINT: `tcp://${CLICKHOUSE_SERVICE_HOST}:${CLICKHOUSE_NATIVE_PORT}`,
    },
    ports: [
      { target: OTLP_GRPC_PORT, protocol: 'tcp', mode: 'ingress' },
      { target: OTLP_HTTP_PORT, protocol: 'tcp', mode: 'ingress' },
    ],
    configs: [{ source: opts.config, target: COLLECTOR_CONFIG_PATH, mode: 0o444 }],
    // `${file:/run/secrets/clickhouse-password}` in the config resolves here.
    secrets: [passwordSecretRef(opts.passwordSecret)],
    networks: [OTEL_OVERLAY_NETWORK],
  };
}

/**
 * Env entries that embed ClickHouse credentials in plaintext: the legacy
 * `CLICKHOUSE_PASSWORD=` on the store and a DSN with userinfo
 * (`CLICKHOUSE_ENDPOINT=http://user:pw@…`) on the collector. Pure.
 */
export function envEmbedsClickhouseSecret(env: readonly string[] | undefined): boolean {
  return (env ?? []).some(
    (e) => e.startsWith('CLICKHOUSE_PASSWORD=') || /^CLICKHOUSE_ENDPOINT=[a-z]+:\/\/[^/@]*@/i.test(e),
  );
}

type ConvergeView = Pick<SwarmServiceInfo, 'configs' | 'mounts' | 'labels'> &
  Partial<Pick<SwarmServiceInfo, 'secrets' | 'env'>>;

/**
 * Whether the live suite has drifted from what we'd deploy now: a service is
 * missing, still carries a legacy host bind mount, references a different
 * config than the current render, does not mount the current password SECRET,
 * still embeds the password in plaintext env (secret-in-config/env installs
 * migrate), or ClickHouse lacks its pin. Pure — the reconcile worker redeploys
 * when this is true.
 */
export function observabilityNeedsConverge(input: {
  store?: ConvergeView;
  collector?: ConvergeView;
  desired: ObservabilityConfigSet;
  /** Where the store should be pinned now ({@link resolveStorePin}). */
  desiredPin?: string;
}): boolean {
  const { store, collector, desired } = input;
  if (!store || !collector) return true;
  const hasBind = (s: Pick<SwarmServiceInfo, 'mounts'>) => (s.mounts ?? []).some((m) => m.type === 'bind');
  if (hasBind(store) || hasBind(collector)) return true;
  if (!(store.configs ?? []).includes(desired.clickhouseInit.name)) return true;
  if (!(collector.configs ?? []).includes(desired.collector.name)) return true;
  const secret = desired.clickhousePassword.name;
  if (!(store.secrets ?? []).includes(secret) || !(collector.secrets ?? []).includes(secret)) return true;
  if (envEmbedsClickhouseSecret(store.env) || envEmbedsClickhouseSecret(collector.env)) return true;
  const pinned = store.labels?.[CLICKHOUSE_NODE_LABEL];
  if (!pinned) return input.desiredPin !== undefined;
  if (input.desiredPin !== undefined && pinned !== input.desiredPin) return true;
  return false;
}

export type SuiteServiceStatus = 'OFFLINE' | 'DEPLOYING' | 'RUNNING' | 'FAILED';

/** A (re)deployed service gets this long to pull + schedule before 0 tasks reads as FAILED. */
export const OBS_START_GRACE_MS = 3 * 60_000;

/**
 * Live status of one suite service from Docker truth (running tasks), never
 * from what was requested. Pure — same shape of reasoning as the ingress
 * `deriveEdgeRuntime`.
 *  - suite disabled ⇒ OFFLINE
 *  - running tasks > 0 ⇒ RUNNING
 *  - not deployed / 0 tasks inside the start grace (since the service's last
 *    spec change, or the enable when it isn't in the inventory yet) ⇒ DEPLOYING
 *  - otherwise ⇒ FAILED (tasks rejected / unschedulable / crash-looping)
 */
export function deriveSuiteServiceStatus(input: {
  enabled: boolean;
  service?: Pick<SwarmServiceInfo, 'runningReplicas' | 'updatedAt'>;
  /** When the suite was last (re)enabled / requested (ms epoch). */
  requestedAt?: number;
  /** A deploy dispatch failed outright (recorded on the config row). */
  deployFailed?: boolean;
  now: number;
}): SuiteServiceStatus {
  if (!input.enabled) return 'OFFLINE';
  const svc = input.service;
  if (svc && svc.runningReplicas > 0) return 'RUNNING';
  if (input.deployFailed) return 'FAILED';
  const since = svc ? svc.updatedAt : input.requestedAt;
  if (since !== undefined && Number.isFinite(since) && input.now - since < OBS_START_GRACE_MS) {
    return 'DEPLOYING';
  }
  return 'FAILED';
}
