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
      unsupported,
    });
    models.push(parsed);
  }

  return { models, warnings };
}
