import type { ServiceSpec } from './protocol/commands';
import { unwrapSecretEnv } from './app-secrets';

/**
 * Raw `docker service inspect` → swarmy {@link ServiceSpec}. PURE and
 * browser-safe: the controller rebuilds a live service's full spec from it
 * before every one-aspect patch (packages/trpc service-patch), and the
 * dashboard reads the same fields (resources, restart policy, update config,
 * command, labels) for the service settings panel. One parser, so the panel
 * shows exactly what a patch would carry.
 */

type Ref = NonNullable<ServiceSpec['secrets']>[number];


function asObj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Rebuild a full {@link ServiceSpec} from a raw `docker service inspect`
 * payload: image, mode, env, command/args, labels, mounts, secrets + configs
 * (with their file targets/uid/gid/mode), ports, restart policy, placement
 * (constraints, spread preferences, max-per-node), resources, healthcheck,
 * rolling-update policy and stop grace period, and the secret-env shim reversed into `secretEnv`.
 * Network NAMES come from the caller (the live inventory —
 * raw inspect only carries network ids). Returns null when unusable.
 */
export function specFromInspect(inspect: unknown, networks: string[]): ServiceSpec | null {
  const spec = asObj(asObj(inspect)?.Spec);
  const name = asStr(spec?.Name);
  if (!spec || !name) return null;
  const tt = asObj(spec.TaskTemplate) ?? {};
  const cs = asObj(tt.ContainerSpec) ?? {};
  // '' when absent — callers that swap/pin the image (promote, inventory tag) fill it.
  const out: ServiceSpec = { name, image: asStr(cs.Image) ?? '' };

  const mode = asObj(spec.Mode);
  const replicas = asNum(asObj(mode?.Replicated)?.Replicas);
  if (replicas !== undefined) out.mode = { replicated: { replicas } };
  else if (mode?.Global !== undefined) out.mode = { global: {} };

  const env: Record<string, string> = {};
  for (const kv of asArr(cs.Env)) {
    if (typeof kv !== 'string') continue;
    const eq = kv.indexOf('=');
    if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  if (Object.keys(env).length > 0) out.env = env;

  const command = asArr(cs.Command).filter((c): c is string => typeof c === 'string');
  if (command.length > 0) out.command = command;
  const args = asArr(cs.Args).filter((a): a is string => typeof a === 'string');
  if (args.length > 0) out.args = args;

  const labels = asObj(spec.Labels);
  if (labels) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) if (typeof v === 'string') clean[k] = v;
    if (Object.keys(clean).length > 0) out.labels = clean;
  }

  const mounts: NonNullable<ServiceSpec['mounts']> = [];
  for (const m of asArr(cs.Mounts)) {
    const mo = asObj(m);
    const type = asStr(mo?.Type);
    const target = asStr(mo?.Target);
    if (!mo || !target || (type !== 'volume' && type !== 'bind' && type !== 'tmpfs')) continue;
    mounts.push({
      type,
      target,
      ...(asStr(mo.Source) ? { source: asStr(mo.Source) } : {}),
      ...(mo.ReadOnly === true ? { readOnly: true } : {}),
    });
  }
  if (mounts.length > 0) out.mounts = mounts;

  const refList = (raw: unknown[], nameKey: 'SecretName' | 'ConfigName') => {
    const refs: Ref[] = [];
    for (const r of raw) {
      const ro = asObj(r);
      const source = asStr(ro?.[nameKey]);
      if (!ro || !source) continue;
      const file = asObj(ro.File);
      refs.push({
        source,
        ...(asStr(file?.Name) ? { target: asStr(file?.Name) } : {}),
        ...(asStr(file?.UID) ? { uid: asStr(file?.UID) } : {}),
        ...(asStr(file?.GID) ? { gid: asStr(file?.GID) } : {}),
        ...(asNum(file?.Mode) !== undefined ? { mode: asNum(file?.Mode) } : {}),
      });
    }
    return refs;
  };
  const secrets = refList(asArr(cs.Secrets), 'SecretName');
  if (secrets.length > 0) out.secrets = secrets;
  const configs = refList(asArr(cs.Configs), 'ConfigName');
  if (configs.length > 0) out.configs = configs;

  const ports: NonNullable<ServiceSpec['ports']> = [];
  for (const p of asArr(asObj(spec.EndpointSpec)?.Ports)) {
    const po = asObj(p);
    const target = asNum(po?.TargetPort);
    if (!po || target === undefined) continue;
    const protocol = asStr(po.Protocol);
    const publishMode = asStr(po.PublishMode);
    ports.push({
      target,
      ...(asNum(po.PublishedPort) !== undefined ? { published: asNum(po.PublishedPort) } : {}),
      protocol: protocol === 'udp' ? 'udp' : 'tcp',
      mode: publishMode === 'host' ? 'host' : 'ingress',
    });
  }
  if (ports.length > 0) out.ports = ports;

  const restart = asObj(tt.RestartPolicy);
  const condition = asStr(restart?.Condition);
  if (condition === 'none' || condition === 'on-failure' || condition === 'any') {
    out.restartPolicy = {
      condition,
      ...(asNum(restart?.MaxAttempts) !== undefined ? { maxAttempts: asNum(restart?.MaxAttempts) } : {}),
      ...(asNum(restart?.Delay) !== undefined ? { delayNs: asNum(restart?.Delay) } : {}),
    };
  }

  // Rolling-update policy — carried so a patch never resets start-first/
  // parallelism to Docker's defaults.
  const upd = asObj(spec.UpdateConfig);
  if (upd) {
    const order = asStr(upd.Order);
    const failureAction = asStr(upd.FailureAction);
    const updateConfig: NonNullable<ServiceSpec['updateConfig']> = {
      ...(asNum(upd.Parallelism) !== undefined ? { parallelism: asNum(upd.Parallelism) } : {}),
      ...(order === 'start-first' || order === 'stop-first' ? { order } : {}),
      ...(failureAction === 'pause' || failureAction === 'continue' || failureAction === 'rollback'
        ? { failureAction }
        : {}),
      ...(asNum(upd.Monitor) !== undefined ? { monitorNs: asNum(upd.Monitor) } : {}),
      ...(asNum(upd.Delay) !== undefined ? { delayNs: asNum(upd.Delay) } : {}),
    };
    if (Object.keys(updateConfig).length > 0) out.updateConfig = updateConfig;
  }

  const placement = asObj(tt.Placement);
  const constraints = asArr(placement?.Constraints).filter((c): c is string => typeof c === 'string');
  const preferences = asArr(placement?.Preferences)
    .map((p) => asStr(asObj(asObj(p)?.Spread)?.SpreadDescriptor))
    .filter((d): d is string => !!d)
    .map((d) => `spread=${d}`);
  const maxReplicasPerNode = asNum(placement?.MaxReplicas);
  if (constraints.length > 0 || preferences.length > 0 || (maxReplicasPerNode ?? 0) > 0) {
    out.placement = {
      ...(constraints.length > 0 ? { constraints } : {}),
      ...(preferences.length > 0 ? { preferences } : {}),
      ...(maxReplicasPerNode && maxReplicasPerNode > 0 ? { maxReplicasPerNode } : {}),
    };
  }

  const res = asObj(tt.Resources);
  const resourcesOf = (side: unknown) => {
    const o = asObj(side);
    const nano = asNum(o?.NanoCPUs);
    const mem = asNum(o?.MemoryBytes);
    if (nano === undefined && mem === undefined) return undefined;
    return {
      ...(nano !== undefined ? { cpus: nano / 1e9 } : {}),
      ...(mem !== undefined ? { memoryBytes: mem } : {}),
    };
  };
  const limits = resourcesOf(res?.Limits);
  const reservations = resourcesOf(res?.Reservations);
  if (limits || reservations) {
    out.resources = { ...(limits ? { limits } : {}), ...(reservations ? { reservations } : {}) };
  }

  const hc = asObj(cs.Healthcheck);
  const test = asArr(hc?.Test).filter((t): t is string => typeof t === 'string');
  if (hc && test.length === 1 && test[0] === 'NONE') {
    out.healthcheck = { disable: true };
  } else if (hc && test.length > 0) {
    out.healthcheck = {
      test,
      ...(asNum(hc.Interval) !== undefined ? { intervalNs: asNum(hc.Interval) } : {}),
      ...(asNum(hc.Timeout) !== undefined ? { timeoutNs: asNum(hc.Timeout) } : {}),
      ...(asNum(hc.StartPeriod) !== undefined ? { startPeriodNs: asNum(hc.StartPeriod) } : {}),
      ...(asNum(hc.Retries) !== undefined ? { retries: asNum(hc.Retries) } : {}),
    };
  }
  const stopGrace = asNum(cs.StopGracePeriod);
  if (stopGrace !== undefined) out.stopGracePeriodNs = stopGrace;

  if (networks.length > 0) out.networks = networks;
  // A service running through the secret-env shim reads back as the user's own
  // command/args + `secretEnv` (the agent re-wraps on deploy) — never
  // double-wrapped, never with the shim baked in as "the command".
  return unwrapSecretEnv(out);
}
