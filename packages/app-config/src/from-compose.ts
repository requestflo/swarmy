/**
 * Convert a docker-compose file into a starter swarmy.yaml (the "Convert
 * compose → swarmy.yaml" step of the New app wizard, epic-git-apps phase 5).
 *
 * Pure: compose text in, swarmy.yaml text + plain-words notes out. It is a
 * STARTER, not a lossless translation — anything it can't express it says so
 * in `notes`, and the result always parses with {@link parseAppConfig}.
 *
 *  - Recognisable data services become managed resources: postgres/postgis →
 *    `postgres`, redis/valkey/keydb → `cache`, meilisearch/typesense →
 *    `search`, qdrant → `vector`, minio → `bucket`.
 *  - Env vars that point at one of those services (`postgres://…@db…`,
 *    `redis://cache:6379`) become bindings (`${{ db.url }}`).
 *  - Everything else is a service: `build:` or `image:`, the first container
 *    port, `command`, `environment`, `deploy.replicas`, named volumes.
 */
import { parse as parseYaml, stringify } from 'yaml';
import { UNIT_NAME_RE } from './schema';
import { parseAppConfig } from './parse';

export interface ComposeConversion {
  /** The swarmy.yaml text, or null when the compose file couldn't be read. */
  yaml: string | null;
  /** What was converted loosely or dropped, in plain words. */
  notes: string[];
}

type ResourceKind = 'postgres' | 'cache' | 'search' | 'vector' | 'bucket';

const RESOURCE_IMAGES: Array<[RegExp, ResourceKind, Record<string, unknown>?]> = [
  [/(^|\/)(postgres|postgis\/postgis|pgvector\/pgvector)(:|$)/, 'postgres'],
  [/(^|\/)(redis|valkey\/valkey|valkey|eqalpha\/keydb|keydb)(:|$)/, 'cache'],
  [/(^|\/)(getmeili\/meilisearch|meilisearch)(:|$)/, 'search', { engine: 'meilisearch' }],
  [/(^|\/)(typesense\/typesense)(:|$)/, 'search', { engine: 'typesense' }],
  [/(^|\/)(qdrant\/qdrant)(:|$)/, 'vector', { engine: 'qdrant' }],
  [/(^|\/)(minio\/minio|bitnami\/minio)(:|$)/, 'bucket'],
];

/** Env-var URL schemes that point at a resource of this kind. */
const URL_SCHEMES: Record<ResourceKind, RegExp> = {
  postgres: /^postgres(ql)?:\/\//i,
  cache: /^rediss?:\/\//i,
  search: /^https?:\/\//i,
  vector: /^https?:\/\//i,
  bucket: /^https?:\/\//i,
};

function unitName(raw: string, taken: Set<string>): string {
  let n = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(n)) n = `s-${n}`;
  n = n.slice(0, 30).replace(/-+$/, '') || 'svc';
  let out = n;
  for (let i = 2; taken.has(out); i++) out = `${n.slice(0, 27)}-${i}`;
  taken.add(out);
  return out;
}

function appName(raw: string): string {
  const n = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return /^[a-z]/.test(n) ? n : `app-${n}`.slice(0, 40);
}

function envOf(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const i = entry.indexOf('=');
      if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = String(v);
    }
    return out;
  }
  return {};
}

/** The container-side port of the first `ports:` / `expose:` entry. */
function firstPort(svc: Record<string, unknown>): number | undefined {
  const candidates = [...(Array.isArray(svc.ports) ? svc.ports : []), ...(Array.isArray(svc.expose) ? svc.expose : [])];
  for (const p of candidates) {
    if (typeof p === 'number') return p;
    if (typeof p === 'string') {
      const target = p.split('/')[0]!.split(':').pop();
      const n = Number(target?.split('-')[0]);
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    }
    if (p && typeof p === 'object' && typeof (p as { target?: unknown }).target === 'number') {
      return (p as { target: number }).target;
    }
  }
  return undefined;
}

function commandOf(raw: unknown): string | string[] | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof x === 'string')) return raw as string[];
  return undefined;
}

function relPath(p: string): string {
  const clean = p.replace(/^\.\/+/, '').replace(/\/+$/, '');
  return clean === '' || clean === '.' ? '.' : clean;
}

/** Convert compose YAML text into a starter swarmy.yaml. */
export function composeToAppConfig(composeText: string, opts: { app?: string } = {}): ComposeConversion {
  const notes: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(composeText);
  } catch (e) {
    return { yaml: null, notes: [`The compose file isn't valid YAML (${e instanceof Error ? e.message : String(e)}).`] };
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!services || typeof services !== 'object' || Object.keys(services).length === 0) {
    return { yaml: null, notes: ['The compose file has no services.'] };
  }

  const taken = new Set<string>();
  // Pass 1: which compose services are managed resources?
  const resources: Record<string, Record<string, unknown> | ResourceKind> = {};
  const resourceByHost = new Map<string, { name: string; kind: ResourceKind }>();
  const appServices: Array<[string, Record<string, unknown>]> = [];
  for (const [rawName, rawSvc] of Object.entries(services as Record<string, unknown>)) {
    const svc = (rawSvc ?? {}) as Record<string, unknown>;
    const image = typeof svc.image === 'string' ? svc.image : '';
    const match = svc.build === undefined ? RESOURCE_IMAGES.find(([re]) => re.test(image)) : undefined;
    if (match) {
      const [, kind, extra] = match;
      const name = unitName(rawName, taken);
      resources[name] = extra ? { type: kind, ...extra } : kind;
      resourceByHost.set(rawName, { name, kind });
      if (typeof svc.container_name === 'string') resourceByHost.set(svc.container_name, { name, kind });
      notes.push(`${rawName} (${image}) becomes a managed ${kind} resource "${name}" — swarmy runs, backs up and wires it.`);
    } else {
      appServices.push([rawName, svc]);
    }
  }
  if (appServices.length === 0) {
    return { yaml: null, notes: [...notes, 'Every service is a database or cache — there is no app service to deploy.'] };
  }

  // Pass 2: app services.
  const out: Record<string, Record<string, unknown>> = {};
  for (const [rawName, svc] of appServices) {
    const name = unitName(rawName, taken);
    const s: Record<string, unknown> = {};
    if (svc.build !== undefined) {
      if (typeof svc.build === 'string') s.build = relPath(svc.build);
      else if (svc.build && typeof svc.build === 'object') {
        const b = svc.build as { context?: unknown; dockerfile?: unknown; target?: unknown; args?: unknown };
        const build: Record<string, unknown> = { path: relPath(typeof b.context === 'string' ? b.context : '.') };
        if (typeof b.dockerfile === 'string') build.dockerfile = b.dockerfile;
        if (typeof b.target === 'string') build.target = b.target;
        const args = envOf(b.args);
        if (Object.keys(args).length) build.args = args;
        s.build = build;
      }
      if (typeof svc.image === 'string') notes.push(`${rawName}: kept build:, dropped image: ${svc.image} (swarmy tags its own builds).`);
    } else if (typeof svc.image === 'string') {
      s.image = svc.image;
    } else {
      notes.push(`${rawName}: has neither build: nor image: — skipped.`);
      continue;
    }
    const command = commandOf(svc.command);
    if (command) s.command = command;
    const port = firstPort(svc);
    if (port) s.port = port;
    const replicas = (svc.deploy as { replicas?: unknown } | undefined)?.replicas;
    if (typeof replicas === 'number' && Number.isInteger(replicas) && replicas >= 0 && replicas <= 100) s.replicas = replicas;

    const env = envOf(svc.environment);
    const bound: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      let replaced: string | null = null;
      for (const [host, r] of resourceByHost) {
        const re = new RegExp(`(^|[@/])${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|/|$)`);
        if (re.test(v) && URL_SCHEMES[r.kind].test(v)) {
          replaced = `\${{ ${r.name}.url }}`;
          break;
        }
        if (v === host) {
          replaced = `\${{ ${r.name}.host }}`;
          break;
        }
      }
      if (replaced) notes.push(`${rawName}: ${k} now binds to ${replaced} (swarmy fills in the real address and password).`);
      else if (/\$\{[^}]+\}/.test(v)) notes.push(`${rawName}: ${k} uses a compose variable (${v}) — set it as a swarmy secret or env value.`);
      bound[k] = replaced ?? v.replace(/\$\{\{/g, '$$${{');
    }
    if (Object.keys(bound).length) s.env = bound;

    const vols: Record<string, string> = {};
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const spec = typeof v === 'string' ? v : v && typeof v === 'object' ? `${(v as { source?: string }).source ?? ''}:${(v as { target?: string }).target ?? ''}` : '';
      const [src, target] = spec.split(':');
      if (!src || !target || !target.startsWith('/')) continue;
      if (src.startsWith('.') || src.startsWith('/') || src.startsWith('~')) {
        notes.push(`${rawName}: bind mount ${src} → ${target} dropped — swarmy services use named volumes.`);
        continue;
      }
      const vname = src.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
      if (UNIT_NAME_RE.test(vname)) vols[vname] = target;
    }
    if (Object.keys(vols).length) s.volumes = vols;
    for (const key of ['healthcheck', 'networks', 'depends_on', 'labels', 'secrets', 'configs']) {
      if (svc[key] !== undefined) notes.push(`${rawName}: ${key}: isn't carried over — ${key === 'depends_on' || key === 'networks' ? 'swarmy wires services and resources itself' : 'add it in swarmy.yaml terms if you need it'}.`);
    }
    out[name] = s;
  }
  if (Object.keys(out).length === 0) return { yaml: null, notes };

  const config: Record<string, unknown> = {
    version: 1,
    app: appName(opts.app ?? 'my-app'),
    services: out,
    ...(Object.keys(resources).length ? { resources } : {}),
  };
  const yaml = `# Converted from docker-compose by swarmy — review before you commit it.\n${stringify(config, { lineWidth: 0 })}`;
  const parsed = parseAppConfig(yaml);
  for (const issue of parsed.issues) {
    if (issue.severity === 'error') notes.push(`Needs a fix before it deploys: ${issue.message}`);
  }
  return { yaml, notes };
}
