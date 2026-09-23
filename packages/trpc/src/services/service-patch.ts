import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError } from '../errors';
import { resolveManagerNode } from './dispatch.service';

/**
 * One-aspect patches of a LIVE service (env / secrets / configs / labels /
 * networks / image) without losing everything else.
 *
 * The agent's `service.deploy` is a full-spec REPLACE. The controller's live
 * inventory view carries only env/labels/ports/networks/secret+config names —
 * no mounts, command, placement, resources, healthcheck, restart policy or
 * secret/config targets. Rebuilding a spec from it and redeploying silently
 * strips all of that (a named data volume detached on every "attach DB").
 *
 * So every patch here reads the service's FULL spec from `service.inspect`,
 * applies the patch to that, and redeploys. If the live spec can't be read the
 * patch is refused — never degraded to a lossy rebuild. Per-network DNS
 * aliases are carried by the agent (`carryNetworkAliases`) since we never set
 * `networkAliases` here.
 */

type Ref = NonNullable<ServiceSpec['secrets']>[number];

// ── pure: raw `docker service inspect` → ServiceSpec ─────────────────────────

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
 * (constraints, spread preferences, max-per-node), resources, healthcheck and
 * stop grace period. Network NAMES come from the caller (the live inventory —
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
    };
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
  return out;
}

// ── pure: apply a one-aspect patch ───────────────────────────────────────────

/** A name matcher: an explicit list, or a predicate over the ref's source name. */
export type NameMatch = readonly string[] | ((name: string) => boolean);

function matcher(m: NameMatch | undefined): (name: string) => boolean {
  if (!m) return () => false;
  if (typeof m === 'function') return m;
  const set = new Set(m);
  return (n) => set.has(n);
}

export interface ServicePatch {
  /** Swap the image (everything else carried). */
  image?: string;
  /** Env keys removed BEFORE `setEnv` is merged. */
  removeEnv?: NameMatch;
  setEnv?: Record<string, string>;
  /** Label keys removed BEFORE `setLabels` is merged. */
  removeLabels?: readonly string[];
  setLabels?: Record<string, string>;
  /** Secret refs dropped (by source name) BEFORE `addSecrets` is applied. */
  removeSecrets?: NameMatch;
  /** Added or replaced (by source name). */
  addSecrets?: Ref[];
  removeConfigs?: NameMatch;
  addConfigs?: Ref[];
  removeNetworks?: readonly string[];
  /** Joined (idempotent — never duplicated). */
  addNetworks?: readonly string[];
  /** Last-step escape hatch for rewrites a declarative field can't express. */
  transform?: (spec: ServiceSpec) => ServiceSpec;
}

function patchRefs(live: Ref[] | undefined, remove: NameMatch | undefined, add: Ref[] | undefined): Ref[] | undefined {
  if (!remove && !add?.length) return live;
  const drop = matcher(remove);
  const adding = new Set((add ?? []).map((r) => r.source));
  const out = [...(live ?? []).filter((r) => !drop(r.source) && !adding.has(r.source)), ...(add ?? [])];
  return out.length > 0 ? out : undefined;
}

/**
 * Apply `patch` to a full live spec. PURE. Everything the patch doesn't name
 * (mounts, command/args, placement, resources, healthcheck, restart policy,
 * ports, mode, stop grace, untouched env/labels/refs/networks) is carried
 * verbatim.
 */
export function applyServicePatch(base: ServiceSpec, patch: ServicePatch): ServiceSpec {
  const out: ServiceSpec = { ...base };
  if (patch.image) out.image = patch.image;

  if (patch.removeEnv || patch.setEnv) {
    const drop = matcher(patch.removeEnv);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base.env ?? {})) if (!drop(k)) env[k] = v;
    Object.assign(env, patch.setEnv ?? {});
    if (Object.keys(env).length > 0) out.env = env;
    else delete out.env;
  }

  if (patch.removeLabels?.length || patch.setLabels) {
    const labels = { ...(base.labels ?? {}) };
    for (const k of patch.removeLabels ?? []) delete labels[k];
    Object.assign(labels, patch.setLabels ?? {});
    out.labels = labels;
  }

  const secrets = patchRefs(base.secrets, patch.removeSecrets, patch.addSecrets);
  if (secrets) out.secrets = secrets;
  else delete out.secrets;
  const configs = patchRefs(base.configs, patch.removeConfigs, patch.addConfigs);
  if (configs) out.configs = configs;
  else delete out.configs;

  if (patch.removeNetworks?.length || patch.addNetworks?.length) {
    const drop = new Set(patch.removeNetworks ?? []);
    const nets = Array.from(
      new Set([...(base.networks ?? []).filter((n) => !drop.has(n)), ...(patch.addNetworks ?? [])]),
    );
    if (nets.length > 0) out.networks = nets;
    else delete out.networks;
  }

  return patch.transform ? patch.transform(out) : out;
}

// ── live: inspect → patch → deploy ───────────────────────────────────────────

/** The live service to patch — its name and resolved network NAMES (inventory). */
export interface LiveServiceRef {
  name: string;
  /** Inventory image (tag form) — preferred over inspect's digest-pinned one. */
  image?: string;
  networks: readonly { name: string }[] | readonly string[];
}

function networkNames(ref: LiveServiceRef): string[] {
  return ref.networks
    .map((n) => (typeof n === 'string' ? n : n.name))
    .filter((n) => n.length > 0);
}

/**
 * Read a live service's FULL spec via `service.inspect`. Throws (never returns
 * a partial spec) when the inspect payload can't be decoded — a redeploy built
 * from less would strip volumes/command/placement.
 */
export async function liveServiceSpec(
  ctx: Pick<OrgContext, 'hub'>,
  nodeId: string,
  ref: LiveServiceRef,
): Promise<ServiceSpec> {
  let raw: { inspect?: unknown } | undefined;
  try {
    raw = await ctx.hub.dispatch<{ inspect?: unknown }>(nodeId, 'service.inspect', { service: ref.name });
  } catch (e) {
    throw mapDispatchError(e);
  }
  const spec = specFromInspect(raw?.inspect, networkNames(ref));
  if (!spec || (!spec.image && !ref.image)) {
    throw commandRejected(
      `could not read the live spec of "${ref.name}" — refusing a redeploy that would drop its volumes/command/placement`,
    );
  }
  return ref.image ? { ...spec, image: ref.image } : spec;
}

export interface PatchLiveServiceOptions {
  /** Manager to dispatch to (resolved when omitted). */
  nodeId?: string;
  pullPolicy?: 'missing' | 'always';
  timeoutMs?: number;
  /**
   * Runs on the fully-patched spec BEFORE the deploy (e.g. the admission gate).
   * Throwing aborts the patch with nothing dispatched.
   */
  beforeDeploy?: (spec: ServiceSpec) => Promise<unknown>;
}

/**
 * inspect → full spec → {@link applyServicePatch} → `service.deploy`. The ONE
 * path every "change one aspect of an existing service" mutation rides. Returns
 * the spec that was deployed.
 */
export async function patchLiveService(
  ctx: OrgContext,
  ref: LiveServiceRef,
  patch: ServicePatch,
  opts: PatchLiveServiceOptions = {},
): Promise<ServiceSpec> {
  const nodeId = opts.nodeId ?? (await resolveManagerNode(ctx)).id;
  const live = await liveServiceSpec(ctx, nodeId, ref);
  const spec = applyServicePatch(live, patch);
  if (opts.beforeDeploy) await opts.beforeDeploy(spec);
  try {
    const payload = { spec, pullPolicy: opts.pullPolicy ?? 'missing' };
    if (opts.timeoutMs) {
      await ctx.hub.dispatch(nodeId, 'service.deploy', payload, { timeoutMs: opts.timeoutMs });
    } else {
      await ctx.hub.dispatch(nodeId, 'service.deploy', payload);
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  return spec;
}
