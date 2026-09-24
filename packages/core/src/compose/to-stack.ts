import { composeToModels, type ComposeFile } from './from-compose';
import { modelToServiceSpec, type ServiceSpecLike } from './to-spec';
import type { TranslationWarning } from './warnings';
import { PLATFORM_PRIVATE_NETWORKS, PLATFORM_SHARED_NETWORKS } from '../network-policy';

/**
 * compose object + stack name -> the namespaced swarm specs a
 * `docker stack deploy` would produce. PURE (no YAML, no I/O) — the controller
 * parses YAML and dispatches; this module owns the NAMING so it is golden-tested.
 *
 * Docker stack conventions this applies:
 *  - swarm service name   = `<stack>_<service>` (service names are swarm-global;
 *    two stacks that both define `web` must never clobber each other),
 *  - named volume         = `<stack>_<volume>` (an `external` volume, or one with
 *    an explicit top-level `name:`, keeps that name),
 *  - network              = `<stack>_<network>` (external / `name:` keep theirs),
 *  - a service that lists no networks joins `<stack>_default`,
 *  - every service joins each of its networks with its SHORT compose name as a
 *    DNS alias (plus any compose `aliases:`), so `db:5432` resolves in-stack,
 *    EXCEPT on swarmy's shared platform network (`swarmy`): aliases there are
 *    dropped (warned) — an app aliasing `postgres` on it could impersonate a
 *    platform name; swarmy's private `swarmy-control` is refused outright,
 *  - secrets/configs: external / undeclared / `name:` keep their name; a
 *    file- or environment-sourced one is referenced as `<stack>_<name>` (swarmy
 *    can't upload the file — create that secret first; warned).
 *
 * Legacy reuse: `legacyVolumes` maps a short service name → mount target →
 * the volume name a previously deployed (bare-named) service mounts there. A
 * named-volume mount at the same target keeps THAT name instead of switching to
 * `<stack>_<vol>` and orphaning the data.
 */

export interface StackNetworkDecl {
  /** Final swarm network name. */
  name: string;
  driver: string;
  attachable: boolean;
  labels: Record<string, string>;
  /** Compose `driver_opts` (e.g. `encrypted`, an MTU) — create-time only. */
  options?: Record<string, string>;
}

export interface StackPlan {
  stack: string;
  /** Namespaced, alias-carrying specs (stack-namespace label NOT yet stamped). */
  specs: ServiceSpecLike[];
  /** short compose key ↔ final swarm service name, in compose order. */
  services: Array<{ short: string; name: string }>;
  /** Non-external networks the stack needs — ensure BEFORE deploying specs. */
  networks: StackNetworkDecl[];
  warnings: TranslationWarning[];
}

export interface ComposeToStackOptions {
  legacyVolumes?: Record<string, Record<string, string>>;
}

/** Raised for a compose document that can't be deployed (caller maps to 400). */
export class ComposeStackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeStackError';
  }
}

export const STACK_NAMESPACE_LABEL = 'com.docker.stack.namespace';
export const DEFAULT_NETWORK_KEY = 'default';
/** Docker caps service names at 63 chars. */
const MAX_SERVICE_NAME = 63;

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;

function listOrDict(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const e of value) {
      const s = String(e);
      const eq = s.indexOf('=');
      if (eq === -1) out[s] = '';
      else out[s.slice(0, eq)] = s.slice(eq + 1);
    }
  } else if (asObj(value)) {
    for (const [k, v] of Object.entries(value as Obj)) out[k] = v == null ? '' : String(v);
  }
  return out;
}

/** Top-level declaration (`volumes.x` / `networks.x` / `secrets.x`) → its final name. */
function declaredName(
  stack: string,
  key: string,
  decl: Obj | undefined,
): { name: string; external: boolean } {
  const ext = decl?.external;
  if (ext === true || asObj(ext)) {
    const extName = asObj(ext)?.name;
    return { name: String(decl?.name ?? extName ?? key), external: true };
  }
  if (decl?.name != null) return { name: String(decl.name), external: false };
  return { name: `${stack}_${key}`, external: false };
}

export function composeToStack(
  doc: ComposeFile | null | undefined,
  stack: string,
  opts: ComposeToStackOptions = {},
): StackPlan {
  const rawServices = asObj(doc?.services) ?? {};
  const shorts = Object.keys(rawServices);
  if (shorts.length === 0) throw new ComposeStackError('compose file defines no services');

  for (const short of shorts) {
    const svc = asObj(rawServices[short]) ?? {};
    if (svc.image == null || String(svc.image).trim() === '') {
      throw new ComposeStackError(
        `service "${short}" has no image — swarm can't build; push an image (or use a git build) and reference it`,
      );
    }
    if (`${stack}_${short}`.length > MAX_SERVICE_NAME) {
      throw new ComposeStackError(
        `service name "${stack}_${short}" exceeds ${MAX_SERVICE_NAME} characters — shorten the stack or service name`,
      );
    }
  }

  let translated: ReturnType<typeof composeToModels>;
  try {
    translated = composeToModels(doc);
  } catch (e) {
    const issues = (e as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
    const detail = issues?.length
      ? issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : e instanceof Error
        ? e.message
        : String(e);
    throw new ComposeStackError(`invalid compose service: ${detail}`);
  }
  const warnings: TranslationWarning[] = [...translated.warnings];

  const topVolumes = asObj(doc?.volumes) ?? {};
  const topNetworks = asObj(doc?.networks) ?? {};
  const topSecrets = asObj(doc?.secrets) ?? {};
  const topConfigs = asObj(doc?.configs) ?? {};

  const networks = new Map<string, StackNetworkDecl>();
  const resolveNetwork = (svcShort: string, key: string): string => {
    const decl = asObj(topNetworks[key]);
    if (!(key in topNetworks) && key !== DEFAULT_NETWORK_KEY) {
      warnings.push({
        level: 'warn',
        path: `${svcShort}.networks.${key}`,
        code: 'undeclared-network',
        message: `network \`${key}\` is not declared under top-level \`networks:\` — created as \`${stack}_${key}\`.`,
      });
    }
    const { name, external } = declaredName(stack, key, decl);
    if (PLATFORM_PRIVATE_NETWORKS.has(name)) {
      throw new ComposeStackError(
        `service "${svcShort}" joins \`${name}\` — that is swarmy's private control-plane network; app services can't join it`,
      );
    }
    if (!external && !networks.has(name) && !PLATFORM_SHARED_NETWORKS.has(name)) {
      const driverOpts = listOrDict(decl?.driver_opts);
      networks.set(name, {
        name,
        driver: decl?.driver != null ? String(decl.driver) : 'overlay',
        attachable: decl?.attachable === false ? false : true,
        labels: {
          ...listOrDict(decl?.labels),
          [STACK_NAMESPACE_LABEL]: stack,
          'swarmy.managed': 'true',
        },
        ...(Object.keys(driverOpts).length ? { options: driverOpts } : {}),
      });
    }
    return name;
  };

  const resolveVolume = (svcShort: string, source: string): string => {
    const decl = asObj(topVolumes[source]);
    if (!(source in topVolumes)) {
      warnings.push({
        level: 'warn',
        path: `${svcShort}.volumes.${source}`,
        code: 'undeclared-volume',
        message: `volume \`${source}\` is not declared under top-level \`volumes:\` — mounted as \`${stack}_${source}\`.`,
      });
    }
    if (decl?.driver != null && String(decl.driver) !== 'local') {
      warnings.push({
        level: 'lossy',
        path: `volumes.${source}.driver`,
        code: 'lossy-mapping',
        message: `volume driver \`${String(decl.driver)}\` is not applied — swarmy mounts it with the node's default driver.`,
      });
    }
    return declaredName(stack, source, decl).name;
  };

  const resolveRef = (kind: 'secrets' | 'configs', svcShort: string, source: string): string => {
    const top = kind === 'secrets' ? topSecrets : topConfigs;
    if (!(source in top)) return source; // an existing swarm object, by name
    const decl = asObj(top[source]);
    const { name, external } = declaredName(stack, source, decl);
    if (!external && (decl?.file != null || decl?.environment != null || decl?.content != null)) {
      warnings.push({
        level: 'warn',
        path: `${svcShort}.${kind}.${source}`,
        code: `${kind === 'secrets' ? 'secret' : 'config'}-source-unsupported`,
        message: `\`${source}\` is sourced from a file/env swarmy can't upload — create a Docker ${kind === 'secrets' ? 'secret' : 'config'} named \`${name}\` before deploying.`,
      });
      return name;
    }
    return name;
  };

  const specs: ServiceSpecLike[] = [];
  const services: StackPlan['services'] = [];
  for (const model of translated.models) {
    const short = model.name;
    const raw = asObj(rawServices[short]) ?? {};
    const name = `${stack}_${short}`;
    const spec = modelToServiceSpec(model);
    spec.name = name;

    // Service labels: compose `labels` (already on the model) + `deploy.labels`
    // (the swarm-service labels in stack semantics; they win).
    const deployLabels = listOrDict(asObj(raw.deploy)?.labels);
    const labels = { ...(spec.labels ?? {}), ...deployLabels, [STACK_NAMESPACE_LABEL]: stack };
    spec.labels = labels;

    // Mounts: namespace named volumes; reuse a legacy service's volume by target.
    const legacy = opts.legacyVolumes?.[short] ?? {};
    const mounts = (spec.mounts ?? []).map((m) => {
      if (m.type !== 'volume') return m;
      const resolved = m.source ? resolveVolume(short, m.source) : undefined;
      const kept = legacy[m.target];
      if (kept) {
        if (kept !== resolved) {
          warnings.push({
            level: 'info',
            path: `${short}.volumes.${m.target}`,
            code: 'legacy-volume-reused',
            message: `keeps mounting the existing volume \`${kept}\` at ${m.target} (deployed before stack-namespaced volumes) so its data is not orphaned.`,
          });
        }
        return { ...m, source: kept };
      }
      return resolved ? { ...m, source: resolved } : m;
    });
    if (mounts.length) spec.mounts = mounts;

    // Networks + short-name aliases.
    const rawNets = raw.networks;
    const keys = model.networks.length ? model.networks : [DEFAULT_NETWORK_KEY];
    const netNames: string[] = [];
    const aliases: Record<string, string[]> = {};
    for (const key of keys) {
      const netName = resolveNetwork(short, key);
      if (netNames.includes(netName)) continue;
      netNames.push(netName);
      const extra = asObj(asObj(rawNets)?.[key])?.aliases;
      if (PLATFORM_SHARED_NETWORKS.has(netName)) {
        warnings.push({
          level: 'info',
          path: `${short}.networks.${key}`,
          code: 'platform-network-alias-dropped',
          message: `joins the shared \`${netName}\` network without DNS aliases — reach it as \`${stack}_${short}\`; for app-to-app traffic use "connect apps".`,
        });
        continue;
      }
      const list = [short, ...(Array.isArray(extra) ? extra.map(String) : [])];
      aliases[netName] = [...new Set(list)];
    }
    spec.networks = netNames;
    spec.networkAliases = aliases;

    const mapRefs = (kind: 'secrets' | 'configs') =>
      spec[kind]?.map((r) => ({ ...r, source: resolveRef(kind, short, r.source) }));
    if (spec.secrets) spec.secrets = mapRefs('secrets');
    if (spec.configs) spec.configs = mapRefs('configs');

    specs.push(spec);
    services.push({ short, name });
  }

  return { stack, specs, services, networks: [...networks.values()], warnings };
}
