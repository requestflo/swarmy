import { specFromInspect } from '@swarmy/core';
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

// The raw-inspect parser lives in @swarmy/core (browser-safe, shared with the
// dashboard's service settings panel); re-exported here for existing callers.
export { specFromInspect } from '@swarmy/core';

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
