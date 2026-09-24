/**
 * Coolify service template → swarmy app template converter. PURE (text in,
 * data out); `scripts/import-coolify-templates.ts` does the file IO.
 *
 * Coolify's templates (https://github.com/coollabsio/coolify, templates/compose)
 * are Apache-2.0: every converted template keeps `source: { kind: 'coolify' }`,
 * which renders an attribution line, and packages/templates/NOTICE carries the
 * licence notice. The importer is a SEEDING tool. Its output is hand-reviewed
 * (pinned tag, memory, healthcheck tools, first-login steps) before anything
 * lands in `src/catalog/*`; nothing is bulk-committed.
 *
 * What it rewrites:
 *  - `SERVICE_URL_<SVC>[_<PORT>]` / `SERVICE_FQDN_<SVC>[_<PORT>]`: declare the
 *    routed service + port; as values they become `${{ app.url }}` /
 *    `${{ app.domain }}` (another service's → `${{ services.<svc>.url }}`).
 *  - `SERVICE_PASSWORD[_64]_X`, `SERVICE_BASE64[_64|_128]_X`,
 *    `SERVICE_REALBASE64[_64|_128]_X`, `SERVICE_HEX_{32,64,128}_X`,
 *    `SERVICE_USER_X`: generated secrets (`generate:` + `${{ secrets.<name> }}`).
 *  - A bundled `postgres` service → managed Postgres (`resources.db`); its
 *    user/password/db vars and hostname become `${{ db.* }}` bindings.
 *  - A bundled redis/valkey/keydb/dragonfly → managed cache (`${{ cache.* }}`).
 *  - `${VAR:-default}` → the default; `${VAR}` with no default → an option
 *    (`[[opt.VAR]]`), flagged for review; `$$` → `$` (swarmy does not
 *    interpolate compose files, so the escape would reach the container).
 *
 * What it refuses (status `rejected`): `build:`, docker.sock / host-device
 * access, privileged / host networking, config-file binds (`content:`),
 * Supabase-style JWT magic vars, and templates Coolify itself marks `ignore`.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { BlueprintCategory, BlueprintOptionView } from '@swarmy/core';
import { loadTemplate } from '../render';
import type { AppTemplate, GeneratedSecret } from '../types';

export type ImportStatus = 'clean' | 'review' | 'rejected';

export interface ImportResult {
  /** Coolify file name without extension. */
  slug: string;
  status: ImportStatus;
  /** Blocking reasons (rejected) and review items. */
  reasons: string[];
  /** Informational: what was dropped or rewritten. */
  info: string[];
  template?: AppTemplate;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;

// ── header ────────────────────────────────────────────────────────────────────

export interface CoolifyHeader {
  documentation?: string;
  slogan?: string;
  category?: string;
  tags?: string;
  logo?: string;
  port?: string;
  ignore?: string;
}

export function parseHeader(text: string): CoolifyHeader {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^#\s*([a-z_]+):\s*(.*)$/);
    if (!m) {
      if (line.trim() && !line.startsWith('#')) break;
      continue;
    }
    out[m[1]!] = m[2]!.trim().replace(/^"(.*)"$/, '$1');
  }
  return out as CoolifyHeader;
}

const CATEGORY_MAP: Record<string, BlueprintCategory> = {
  productivity: 'productivity',
  storage: 'productivity',
  documentation: 'productivity',
  finance: 'business',
  helpdesk: 'business',
  email: 'business',
  mail: 'business',
  media: 'media',
  games: 'media',
  devtools: 'devtools',
  development: 'devtools',
  'developer-tools': 'devtools',
  git: 'devtools',
  ci: 'devtools',
  api: 'devtools',
  backend: 'devtools',
  cms: 'cms',
  ai: 'ai',
  mcp: 'ai',
  monitoring: 'monitoring',
  health: 'monitoring',
  automation: 'automation',
  analytics: 'analytics',
  messaging: 'comms',
  communication: 'comms',
  database: 'data',
  databases: 'data',
  search: 'data',
};

export function mapCategory(raw: string | undefined): BlueprintCategory {
  const first = (raw ?? '').split(',')[0]!.trim().toLowerCase();
  return CATEGORY_MAP[first] ?? 'app';
}

// ── magic variables ───────────────────────────────────────────────────────────

const MAGIC_GEN: Record<string, GeneratedSecret> = {
  PASSWORD: { format: 'alnum', length: 32 },
  PASSWORD_64: { format: 'alnum', length: 64 },
  PASSWORDWITHSYMBOLS: { format: 'alnum', length: 32 },
  PASSWORDWITHSYMBOLS_64: { format: 'alnum', length: 64 },
  // Coolify's BASE64 is "not base64, just a random string".
  BASE64: { format: 'alnum', length: 32 },
  BASE64_32: { format: 'alnum', length: 32 },
  BASE64_64: { format: 'alnum', length: 64 },
  BASE64_128: { format: 'alnum', length: 128 },
  // REALBASE64_N = base64 of N random bytes → base64url of the same entropy.
  REALBASE64: { format: 'base64url', length: 43 },
  REALBASE64_32: { format: 'base64url', length: 43 },
  REALBASE64_64: { format: 'base64url', length: 86 },
  REALBASE64_128: { format: 'base64url', length: 171 },
  HEX_32: { format: 'hex', length: 32 },
  HEX_64: { format: 'hex', length: 64 },
  HEX_128: { format: 'hex', length: 128 },
  USER: { format: 'alnum', length: 16 },
  LOWERCASEUSER: { format: 'hex', length: 16 },
};
const MAGIC_KINDS = Object.keys(MAGIC_GEN).sort((a, b) => b.length - a.length);

type Magic =
  | { kind: 'url' | 'fqdn'; service: string; port?: number }
  | { kind: 'gen'; gen: GeneratedSecret; name: string; raw: string }
  | { kind: 'unsupported'; raw: string };

export function parseMagic(name: string): Magic | null {
  if (!name.startsWith('SERVICE_')) return null;
  const rest = name.slice('SERVICE_'.length);
  const url = rest.match(/^(URL|FQDN)_([A-Z0-9_]+?)(?:_(\d{2,5}))?$/);
  if (url) {
    return {
      kind: url[1] === 'URL' ? 'url' : 'fqdn',
      service: url[2]!.toLowerCase().replace(/_/g, '-'),
      ...(url[3] ? { port: Number(url[3]) } : {}),
    };
  }
  for (const k of MAGIC_KINDS) {
    if (rest.startsWith(`${k}_`)) {
      const suffix = rest.slice(k.length + 1);
      const base = suffix.toLowerCase().replace(/_/g, '-');
      const what = k.startsWith('USER') || k === 'LOWERCASEUSER' ? 'user' : k.startsWith('PASSWORD') ? 'password' : 'key';
      return { kind: 'gen', gen: MAGIC_GEN[k]!, name: `${base}-${what}`.replace(/^-+/, ''), raw: name };
    }
  }
  return { kind: 'unsupported', raw: name };
}

// ── env interpolation ─────────────────────────────────────────────────────────

/** `$VAR`, `${VAR}`, `${VAR:-def}`, `${VAR-def}`, `${VAR:?msg}`; `$$` = literal `$`. */
const REF_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*)|:?\?[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

interface VarRef {
  name: string;
  default?: string;
}

export function envRefs(value: string): VarRef[] {
  const out: VarRef[] = [];
  for (const m of value.matchAll(REF_RE)) {
    if (m[0] === '$$') continue;
    const name = m[1] ?? m[4]!;
    out.push(m[3] !== undefined ? { name, default: m[3] } : { name });
  }
  return out;
}

function listOrDict(value: unknown): Array<[string, string | null]> {
  if (Array.isArray(value)) {
    return value.map((e) => {
      const s = String(e);
      const eq = s.indexOf('=');
      return eq === -1 ? [s, null] : [s.slice(0, eq), s.slice(eq + 1)];
    });
  }
  const o = asObj(value);
  return o ? Object.entries(o).map(([k, v]) => [k, v == null ? null : String(v)]) : [];
}

// ── classification ────────────────────────────────────────────────────────────

const PG_IMAGE = /^(docker\.io\/)?(library\/)?postgres:/;
const CACHE_IMAGE = /(^|\/)(redis|valkey|keydb|dragonfly|redis-stack-server)(:|$)|valkey\/valkey|eqalpha\/keydb|dragonflydb/;
const UNSUPPORTED_KEYS = ['privileged', 'network_mode', 'devices', 'cap_add', 'pid', 'ipc', 'sysctls', 'userns_mode'];
const DROPPED_KEYS = ['depends_on', 'restart', 'container_name', 'labels', 'exclude_from_hc', 'expose', 'logging', 'stop_grace_period', 'ports', 'platform', 'hostname', 'extra_hosts', 'tty', 'stdin_open', 'working_dir', 'init', 'shm_size', 'ulimits', 'deploy', 'mem_limit', 'user'];

const RESERVED = new Set(['app', 'apps', 'services', 'secrets', 'preview']);
const unit = (s: string): string => {
  const u =
    s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^([0-9])/, 's$1').slice(0, 26) ||
    'web';
  return RESERVED.has(u) ? `${u}-svc` : u;
};

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function tagline(slogan: string | undefined, name: string): string {
  const s = (slogan ?? `${name}, self-hosted`).replace(/\s+/g, ' ').trim();
  const first = s.split(/(?<=[.!?])\s/)[0]!.replace(/[.!]+$/, '');
  return first.length > 110 ? `${first.slice(0, 107).trimEnd()}…` : first;
}

function imageTag(image: string): string | undefined {
  const last = image.split('@')[0]!.split('/').pop()!;
  return last.includes(':') ? last.split(':')[1] : undefined;
}

function composeHealthcheck(hc: Obj): Obj | undefined {
  if (hc.disable === true) return undefined;
  const test = hc.test;
  let command: string | string[] | undefined;
  if (Array.isArray(test)) {
    const [head, ...rest] = test.map(String);
    if (head === 'NONE') return undefined;
    command = head === 'CMD-SHELL' ? rest.join(' ') : head === 'CMD' ? rest : [head!, ...rest];
  } else if (typeof test === 'string') {
    command = test;
  }
  if (!command || (Array.isArray(command) && command.length === 0)) return undefined;
  const unescape = (s: string): string => s.replace(/\$\$/g, '$');
  const out: Obj = { command: Array.isArray(command) ? command.map(unescape) : unescape(command) };
  for (const k of ['interval', 'timeout', 'start_period'] as const) {
    if (hc[k] != null) out[k] = String(hc[k]);
  }
  if (hc.retries != null) out.retries = Math.min(20, Math.max(1, Number(hc.retries)));
  return out;
}

// ── convert ───────────────────────────────────────────────────────────────────

export function convertCoolifyTemplate(slug: string, text: string): ImportResult {
  const reasons: string[] = [];
  const review: string[] = [];
  const info: string[] = [];
  const reject = (why: string): ImportResult => ({ slug, status: 'rejected', reasons: [why, ...reasons], info });

  const header = parseHeader(text);
  if (header.ignore === 'true') return reject('marked `ignore: true` upstream (broken or unmaintained)');
  let doc: Obj;
  try {
    doc = asObj(parseYaml(text)) ?? {};
  } catch (e) {
    return reject(`YAML does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  const services = asObj(doc.services);
  if (!services || Object.keys(services).length === 0) return reject('no services');

  // Pass 1: classify, spot blockers.
  let pgKey: string | undefined;
  let cacheKey: string | undefined;
  for (const [key, raw] of Object.entries(services)) {
    const svc = asObj(raw) ?? {};
    if (svc.build !== undefined) return reject(`${key}: uses build: (swarmy templates are image-only)`);
    const image = String(svc.image ?? '');
    if (!image) return reject(`${key}: no image`);
    for (const k of UNSUPPORTED_KEYS) if (svc[k] !== undefined) return reject(`${key}: uses ${k}`);
    if (svc.entrypoint !== undefined) return reject(`${key}: overrides entrypoint (not in swarmy.yaml v1)`);
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const s = typeof v === 'string' ? v : String(asObj(v)?.source ?? '');
      if (s.includes('docker.sock')) return reject(`${key}: mounts the Docker socket`);
      if (asObj(v)?.content !== undefined) return reject(`${key}: needs a generated config file (bind with content:)`);
      if (s.startsWith('/dev') || s.startsWith('/proc') || s.startsWith('/sys')) return reject(`${key}: mounts host ${s}`);
    }
    if (PG_IMAGE.test(image) && !pgKey) pgKey = key;
    else if (CACHE_IMAGE.test(image) && !cacheKey) cacheKey = key;
    else if (PG_IMAGE.test(image)) review.push(`${key}: a second Postgres stays bundled`);
  }

  // Managed-resource var bindings.
  const varBinding = new Map<string, string>();
  let database = 'app';
  if (pgKey) {
    const env = new Map(listOrDict(asObj(services[pgKey])?.environment));
    const bindVar = (envKey: string, binding: string): void => {
      const v = env.get(envKey);
      if (!v) return;
      const refs = envRefs(v);
      if (refs.length === 1) {
        varBinding.set(refs[0]!.name, binding);
        if (envKey === 'POSTGRES_DB' && refs[0]!.default) database = refs[0]!.default;
      } else if (envKey === 'POSTGRES_DB') {
        database = v;
      }
    };
    bindVar('POSTGRES_USER', '${{ db.user }}');
    bindVar('POSTGRES_PASSWORD', '${{ db.password }}');
    bindVar('POSTGRES_DB', '${{ db.database }}');
    database = database.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 63) || 'app';
    info.push(`${pgKey}: bundled Postgres → managed Postgres (backups, PITR, HA)`);
  }
  if (cacheKey) {
    const svc = asObj(services[cacheKey]) ?? {};
    const texts = [
      ...listOrDict(svc.environment).map(([, v]) => v ?? ''),
      Array.isArray(svc.command) ? svc.command.join(' ') : String(svc.command ?? ''),
    ];
    for (const t of texts) {
      for (const r of envRefs(t)) {
        if (/PASSWORD/.test(r.name)) varBinding.set(r.name, '${{ cache.password }}');
      }
    }
    info.push(`${cacheKey}: bundled ${String(svc.image).split(':')[0]} → managed Valkey cache`);
  }

  const keyMap = new Map<string, string>();
  for (const key of Object.keys(services)) if (key !== pgKey && key !== cacheKey) keyMap.set(key, unit(key));
  const hostBinding = (value: string): string => {
    let v = value;
    const swap = (svcKey: string | undefined, binding: string): void => {
      if (!svcKey) return;
      const esc = svcKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      v = v.replace(new RegExp(`(^|[@/=,;\\s]|//)${esc}(?=:(?!//)|[/,;?\\s]|$)`, 'g'), `$1${binding}`);
    };
    swap(pgKey, '${{ db.host }}');
    swap(cacheKey, '${{ cache.host }}');
    return v;
  };

  const generate: Record<string, GeneratedSecret> = {};
  const options: BlueprintOptionView[] = [];
  let primary: { service: string; port?: number } | undefined;
  const headerPort = header.port ? Number(header.port) : undefined;

  // Pass 2: build the swarmy.yaml services.
  const outServices: Obj = {};
  for (const [key, raw] of Object.entries(services)) {
    if (key === pgKey || key === cacheKey) continue;
    const svc = asObj(raw) ?? {};
    const name = keyMap.get(key)!;
    const out: Obj = { image: String(svc.image) };
    const tag = imageTag(String(svc.image));
    if (!tag || /^(latest|main|master|stable|nightly|edge|dev|release)$/.test(tag)) {
      review.push(`${name}: image ${String(svc.image)} is not pinned to a release`);
    }
    if (svc.command !== undefined) {
      const c = svc.command;
      out.command = Array.isArray(c) ? c.map((x) => String(x).replace(/\$\$/g, '$')) : String(c).replace(/\$\$/g, '$');
      if (envRefs(Array.isArray(c) ? c.join(' ') : String(c)).length) {
        review.push(`${name}: command interpolates variables (swarmy passes it verbatim; the container shell must expand them)`);
      }
    }
    const env: Obj = {};
    for (const [k, v] of listOrDict(svc.environment)) {
      const m = parseMagic(k);
      if (v === null) {
        if (m && (m.kind === 'url' || m.kind === 'fqdn')) {
          primary ??= { service: name, ...(m.port ? { port: m.port } : {}) };
          continue;
        }
        info.push(`${name}: dropped bare env ${k}`);
        continue;
      }
      let unresolvedOptional = false;
      let value = v.replace(REF_RE, (whole, braced: string | undefined, op: string | undefined, def: string | undefined, bare: string | undefined) => {
        if (whole === '$$') return '$';
        const ref = braced ?? bare!;
        const bound = varBinding.get(ref);
        if (bound) return bound;
        const magic = parseMagic(ref);
        if (magic?.kind === 'url' || magic?.kind === 'fqdn') {
          const target = magic.service === name || magic.service === key.toLowerCase() || !keyMap.has(magic.service) ? 'app' : magic.service;
          if (target === 'app') {
            primary ??= { service: name, ...(magic.port ? { port: magic.port } : {}) };
            return magic.kind === 'url' ? '${{ app.url }}' : '${{ app.domain }}';
          }
          return magic.kind === 'url' ? `\${{ services.${unit(target)}.url }}` : `\${{ services.${unit(target)}.host }}`;
        }
        if (magic?.kind === 'gen') {
          generate[magic.name] = magic.gen;
          return `\${{ secrets.${magic.name} }}`;
        }
        if (magic?.kind === 'unsupported') {
          reasons.push(`${name}.${k}: unsupported Coolify magic variable ${magic.raw}`);
          return whole;
        }
        if (op !== undefined) return def ?? '';
        // A plain `${VAR}` with no default: user input.
        if (whole === v.trim() || v.trim() === `$${ref}`) {
          unresolvedOptional = true;
          return '';
        }
        const optKey = ref.replace(/[^A-Za-z0-9_]/g, '_');
        if (!options.some((o) => o.key === optKey)) {
          options.push({ key: optKey, label: ref, kind: 'string', help: 'Required by the upstream template.', defaultValue: '' });
          review.push(`${name}.${k}: needs user input ${ref} (added as option)`);
        }
        return `[[opt.${optKey}]]`;
      });
      if (unresolvedOptional && value === '') {
        info.push(`${name}: dropped optional env ${k} (no default upstream)`);
        continue;
      }
      value = hostBinding(value);
      env[k] = value;
    }
    if (Object.keys(env).length) out.env = env;
    const volumes: Obj = {};
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      let source: string;
      let target: string;
      if (typeof v === 'string') {
        const parts = v.split(':');
        if (parts.length < 2) {
          info.push(`${name}: dropped anonymous volume ${v}`);
          continue;
        }
        [source, target] = [parts[0]!, parts[1]!];
      } else {
        const o = asObj(v) ?? {};
        source = String(o.source ?? '');
        target = String(o.target ?? '');
        if (o.type === 'tmpfs' || !source) continue;
      }
      if (source.startsWith('.') || source.startsWith('/')) {
        review.push(`${name}: bind mount ${source} converted to a named volume`);
      }
      volumes[unit(source.split('/').filter(Boolean).pop() ?? 'data')] = target;
    }
    if (Object.keys(volumes).length) out.volumes = volumes;
    const hc = asObj(svc.healthcheck);
    const health = hc ? composeHealthcheck(hc) : undefined;
    if (health) out.healthcheck = health;
    else review.push(`${name}: no healthcheck (check the image for its own HEALTHCHECK, or add one)`);
    out.memory = '512mb';
    for (const k of DROPPED_KEYS) if (svc[k] !== undefined && k !== 'depends_on' && k !== 'restart') info.push(`${name}: dropped ${k}`);
    outServices[name] = out;
  }
  if (Object.keys(outServices).length === 0) return reject('only data services, nothing to route');
  review.push('memory limits are a 512mb guess: size each service');
  review.push('write real first-login steps (postDeploy)');

  // Primary service + port.
  const primaryName =
    primary?.service ?? (Object.keys(outServices).length === 1 ? Object.keys(outServices)[0]! : undefined);
  const port = primary?.port ?? headerPort;
  if (!primaryName || !port) {
    reasons.push('no routable HTTP service/port could be determined');
  } else {
    (outServices[primaryName] as Obj).port = port;
  }

  const resources: Obj = {};
  if (pgKey) resources.db = { type: 'postgres', database };
  if (cacheKey) resources.cache = { type: 'cache', memory: '64mb' };

  const config: Obj = { version: 1, app: unit(slug).replace(/^[^a-z]/, 'a'), services: outServices };
  if (Object.keys(resources).length) config.resources = resources;
  const yaml = stringifyYaml(config, { lineWidth: 0 });

  const primaryImage = primaryName ? String((outServices[primaryName] as Obj).image) : '';
  const template: AppTemplate = {
    id: unit(slug),
    name: titleCase(slug),
    tagline: tagline(header.slogan, titleCase(slug)),
    category: mapCategory(header.category),
    icon: slug.toLowerCase().replace(/[^a-z0-9]/g, ''),
    website: header.documentation?.startsWith('https://') ? header.documentation.split('?')[0]! : 'https://coolify.io',
    version: imageTag(primaryImage) ?? 'unknown',
    yaml,
    ...(primaryName && Object.keys(outServices).filter((k) => (outServices[k] as Obj).port).length > 1 ? { primary: primaryName } : {}),
    ...(Object.keys(generate).length ? { generate } : {}),
    ...(options.length ? { options } : {}),
    postDeploy: ['Open <url> and finish the setup wizard.'],
    source: { kind: 'coolify', path: `templates/compose/${slug}.yaml` },
  };

  if (reasons.length) return { slug, status: 'rejected', reasons, info, template };

  const loaded = loadTemplate(template, { stack: 'demo' });
  const errors = loaded.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    return {
      slug,
      status: 'rejected',
      reasons: errors.map((e) => `swarmy.yaml: ${e.path.join('.')}: ${e.message}`),
      info,
      template,
    };
  }
  // The two generic review items are always present; anything beyond them needs a human.
  const status: ImportStatus = review.length > 2 ? 'review' : 'clean';
  return { slug, status, reasons: review, info, template };
}

/** Render a converted template as TypeScript source for hand-review. */
export function templateSource(t: AppTemplate): string {
  const { yaml, ...meta } = t;
  const json = JSON.stringify(meta, null, 2)
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:')
    .replace(/\n\}$/, '');
  const body = yaml.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `${json},\n  yaml: \`${body}\`,\n}`;
}
