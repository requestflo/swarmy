import { ServiceModel, type ServiceModelOut } from './model';
import { SWARM_INCOMPATIBLE_KEYS, type TranslationWarning } from './warnings';

/**
 * compose object -> canonical ServiceModel[]. PURE — the caller is responsible
 * for parsing YAML into a plain object (the controller's tRPC layer has the
 * `yaml` lib; core stays node-free and browser-safe).
 *
 * Normalizes compose's union encodings (list_or_dict env, "8080:80" port
 * strings, shell/exec command) into the model's canonical object shapes.
 */

export interface ComposeFile {
  services?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FromComposeResult {
  models: ServiceModelOut[];
  warnings: TranslationWarning[];
}

/** compose `list_or_dict` (environment, labels) -> Record<string,string>. */
function listOrDict(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const s = String(entry);
      const eq = s.indexOf('=');
      if (eq === -1) out[s] = '';
      else out[s.slice(0, eq)] = s.slice(eq + 1);
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v == null ? '' : String(v);
    }
  }
  return out;
}

/** A compose command/entrypoint is either a shell string or an exec array. */
function stringOrList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.length > 0) return value.split(/\s+/);
  return [];
}

/** Parse one compose port entry into a normalized ModelPort-ish object. */
function parsePort(entry: unknown): {
  target: number;
  published?: number;
  protocol: 'tcp' | 'udp';
  mode: 'ingress' | 'host';
} | null {
  // Long form: { target, published, protocol, mode }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const o = entry as Record<string, unknown>;
    const target = Number(o.target);
    if (!Number.isFinite(target)) return null;
    const published = o.published != null ? Number(o.published) : undefined;
    const protocol = o.protocol === 'udp' ? 'udp' : 'tcp';
    const mode = o.mode === 'host' ? 'host' : 'ingress';
    return { target, published: Number.isFinite(published) ? published : undefined, protocol, mode };
  }
  // Short form: "8080:80/tcp", "80", "127.0.0.1:8080:80"
  const raw = String(entry);
  const [hostAndPorts, proto] = raw.split('/');
  const protocol = proto === 'udp' ? 'udp' : 'tcp';
  const parts = (hostAndPorts ?? '').split(':');
  const targetStr = parts[parts.length - 1];
  const target = Number(targetStr);
  if (!Number.isFinite(target)) return null;
  const published = parts.length >= 2 ? Number(parts[parts.length - 2]) : undefined;
  return {
    target,
    published: Number.isFinite(published) ? published : undefined,
    protocol,
    mode: 'ingress',
  };
}

/** Parse one compose volumes entry (short or long form) into a ModelMount-ish. */
function parseMount(entry: unknown): {
  type: 'volume' | 'bind' | 'tmpfs';
  source?: string;
  target: string;
  readOnly: boolean;
} | null {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const o = entry as Record<string, unknown>;
    const target = o.target != null ? String(o.target) : '';
    if (!target) return null;
    const type =
      o.type === 'bind' || o.type === 'tmpfs' ? (o.type as 'bind' | 'tmpfs') : 'volume';
    return {
      type,
      source: o.source != null ? String(o.source) : undefined,
      target,
      readOnly: o.read_only === true,
    };
  }
  // Short form: "src:/dst:ro", "/abs:/dst", "named:/dst", "/dst"
  const raw = String(entry);
  const segs = raw.split(':');
  if (segs.length === 1) {
    return { type: 'volume', target: segs[0] ?? raw, readOnly: false };
  }
  const source = segs[0];
  const target = segs[1];
  if (!target) return null;
  const readOnly = segs[2] === 'ro';
  const isBind = source != null && (source.startsWith('/') || source.startsWith('.') || source.startsWith('~'));
  return { type: isBind ? 'bind' : 'volume', source, target, readOnly };
}

function networkNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === 'object') return Object.keys(value as object);
  return [];
}

const DURATION_UNITS: Record<string, number> = {
  ns: 1,
  us: 1_000,
  µs: 1_000,
  ms: 1_000_000,
  s: 1_000_000_000,
  m: 60_000_000_000,
  h: 3_600_000_000_000,
};

/** compose duration ("1m30s", "10s", 5000000000) -> nanoseconds. */
function parseDurationNs(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Math.round(value);
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) != null) {
    matched = true;
    total += Number(m[1]) * (DURATION_UNITS[m[2] as string] ?? 0);
  }
  return matched ? Math.round(total) : undefined;
}

/** compose cpu quota ("0.5", 0.5, "500m") -> fractional cores. */
function parseCpus(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (s.endsWith('m')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 1000 : undefined;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** compose memory ("512M", "1g", 536870912) -> bytes. */
function parseBytes(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Math.round(value);
  const s = String(value).trim();
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?)b?$/i.exec(s);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  const scale: Record<string, number> = {
    '': 1,
    k: 1000,
    ki: 1024,
    m: 1000 ** 2,
    mi: 1024 ** 2,
    g: 1000 ** 3,
    gi: 1024 ** 3,
    t: 1000 ** 4,
    ti: 1024 ** 4,
  };
  return Math.round(Number(m[1]) * (scale[(m[2] as string).toLowerCase()] ?? 1));
}

/** compose `healthcheck` -> ModelHealthcheck shape (durations in ns). */
function parseHealthcheck(value: unknown): {
  test: string[];
  intervalNs?: number;
  timeoutNs?: number;
  startPeriodNs?: number;
  retries?: number;
  disable?: boolean;
} | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const test = Array.isArray(o.test) ? o.test.map(String) : typeof o.test === 'string' ? ['CMD-SHELL', o.test] : [];
  return {
    test,
    intervalNs: parseDurationNs(o.interval),
    timeoutNs: parseDurationNs(o.timeout),
    startPeriodNs: parseDurationNs(o.start_period),
    retries: o.retries != null ? Number(o.retries) : undefined,
    disable: o.disable === true ? true : undefined,
  };
}

/** compose `deploy.resources` -> ModelResources. */
function parseResources(value: unknown):
  | { limits?: { cpus?: number; memoryBytes?: number }; reservations?: { cpus?: number; memoryBytes?: number } }
  | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const bucket = (b: unknown): { cpus?: number; memoryBytes?: number } | undefined => {
    if (!b || typeof b !== 'object') return undefined;
    const bo = b as Record<string, unknown>;
    const cpus = parseCpus(bo.cpus);
    const memoryBytes = parseBytes(bo.memory);
    if (cpus == null && memoryBytes == null) return undefined;
    return { ...(cpus != null ? { cpus } : {}), ...(memoryBytes != null ? { memoryBytes } : {}) };
  };
  const limits = bucket(o.limits);
  const reservations = bucket(o.reservations);
  if (!limits && !reservations) return undefined;
  return { ...(limits ? { limits } : {}), ...(reservations ? { reservations } : {}) };
}

/** compose `configs`/`secrets` (short string or long object) -> refs. */
function parseConfigSecrets(value: unknown): Array<{
  source: string;
  target?: string;
  uid?: string;
  gid?: string;
  mode?: number;
}> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ source: string; target?: string; uid?: string; gid?: string; mode?: number }> = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push({ source: entry });
    } else if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      if (o.source == null) continue;
      out.push({
        source: String(o.source),
        target: o.target != null ? String(o.target) : undefined,
        uid: o.uid != null ? String(o.uid) : undefined,
        gid: o.gid != null ? String(o.gid) : undefined,
        mode: o.mode != null ? Number(o.mode) : undefined,
      });
    }
  }
  return out;
}

/** compose `ulimits` (number or {soft,hard}) -> ModelUlimit[]. */
function parseUlimits(value: unknown): Array<{ name: string; soft?: number; hard?: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: Array<{ name: string; soft?: number; hard?: number }> = [];
  for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number') out.push({ name, soft: v, hard: v });
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      out.push({
        name,
        soft: o.soft != null ? Number(o.soft) : undefined,
        hard: o.hard != null ? Number(o.hard) : undefined,
      });
    }
  }
  return out;
}

/** compose `logging` -> ModelLogging. */
function parseLogging(value: unknown): { driver?: string; options: Record<string, string> } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const options: Record<string, string> = {};
  if (o.options && typeof o.options === 'object') {
    for (const [k, v] of Object.entries(o.options as Record<string, unknown>)) options[k] = String(v);
  }
  const driver = o.driver != null ? String(o.driver) : undefined;
  if (driver == null && Object.keys(options).length === 0) return undefined;
  return { driver, options };
}

/** compose `depends_on` (list or map) -> service names. */
function dependsOnNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === 'object') return Object.keys(value as object);
  return [];
}

/** Keys we fully map; everything else falls through to `unsupported`. */
const MAPPED_KEYS = new Set([
  'image',
  'environment',
  'command',
  'entrypoint',
  'ports',
  'volumes',
  'networks',
  'labels',
  'deploy',
  'restart',
  'healthcheck',
  'configs',
  'secrets',
  'ulimits',
  'logging',
  'depends_on',
  'stop_grace_period',
]);

export function composeToModels(doc: ComposeFile | null | undefined): FromComposeResult {
  const warnings: TranslationWarning[] = [];
  const services = (doc?.services ?? {}) as Record<string, Record<string, unknown>>;
  const models: ServiceModelOut[] = [];

  for (const [name, svc] of Object.entries(services)) {
    const deploy = (svc.deploy ?? {}) as Record<string, unknown>;
    const placementRaw = (deploy.placement ?? {}) as Record<string, unknown>;
    const restartRaw = (deploy.restart_policy ?? {}) as Record<string, unknown>;

    const ports = Array.isArray(svc.ports)
      ? svc.ports.map(parsePort).filter((p): p is NonNullable<typeof p> => p != null)
      : [];
    const mounts = Array.isArray(svc.volumes)
      ? svc.volumes.map(parseMount).filter((m): m is NonNullable<typeof m> => m != null)
      : [];

    const replicasRaw = deploy.replicas;
    const isGlobal = (deploy.mode as string | undefined) === 'global';

    const preferences = Array.isArray(placementRaw.preferences)
      ? (placementRaw.preferences as unknown[]).map((p) =>
          p && typeof p === 'object'
            ? Object.entries(p as Record<string, unknown>)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(',')
            : String(p),
        )
      : [];

    const placement =
      (Array.isArray(placementRaw.constraints) && placementRaw.constraints.length) ||
      preferences.length ||
      placementRaw.max_replicas_per_node != null
        ? {
            constraints: Array.isArray(placementRaw.constraints)
              ? (placementRaw.constraints as unknown[]).map(String)
              : [],
            preferences,
            maxReplicasPerNode:
              placementRaw.max_replicas_per_node != null
                ? Number(placementRaw.max_replicas_per_node)
                : undefined,
          }
        : undefined;

    // Preserve unsupported / swarm-incompatible top-level keys verbatim.
    const unsupported: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(svc)) {
      if (MAPPED_KEYS.has(k)) continue;
      unsupported[k] = v;
      const level = SWARM_INCOMPATIBLE_KEYS.has(k) ? 'warn' : 'info';
      warnings.push({
        level,
        path: `${name}.${k}`,
        code: SWARM_INCOMPATIBLE_KEYS.has(k) ? 'swarm-incompatible' : 'unsupported-key',
        message: SWARM_INCOMPATIBLE_KEYS.has(k)
          ? `\`${k}\` is valid compose but ignored by Swarm — preserved on export, not deployed.`
          : `\`${k}\` is not modeled by swarmy — preserved on export.`,
      });
    }

    const dependsOn = dependsOnNames(svc.depends_on);
    if (dependsOn.length) {
      warnings.push({
        level: 'warn',
        path: `${name}.depends_on`,
        code: 'lossy-mapping',
        message:
          '`depends_on` start-order is not enforced by Swarm — captured, but services start concurrently.',
      });
    }

    const parsed = ServiceModel.parse({
      name,
      image: svc.image != null ? String(svc.image) : '',
      mode: isGlobal ? 'global' : 'replicated',
      replicas: replicasRaw != null ? Number(replicasRaw) : 1,
      env: listOrDict(svc.environment),
      command: stringOrList(svc.command),
      args: [],
      ports,
      mounts,
      networks: networkNames(svc.networks),
      labels: listOrDict(svc.labels),
      restart:
        restartRaw.condition != null || restartRaw.max_attempts != null
          ? {
              condition: restartRaw.condition as 'none' | 'on-failure' | 'any' | undefined,
              maxAttempts:
                restartRaw.max_attempts != null ? Number(restartRaw.max_attempts) : undefined,
            }
          : undefined,
      placement,
      healthcheck: parseHealthcheck(svc.healthcheck),
      resources: parseResources(deploy.resources),
      configs: parseConfigSecrets(svc.configs),
      secrets: parseConfigSecrets(svc.secrets),
      ulimits: parseUlimits(svc.ulimits),
      logging: parseLogging(svc.logging),
      dependsOn,
      stopGracePeriodNs: parseDurationNs(svc.stop_grace_period),
      unsupported,
    });
    models.push(parsed);
  }

  return { models, warnings };
}
