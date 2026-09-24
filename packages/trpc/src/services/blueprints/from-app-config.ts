import { stringify as stringifyYaml } from 'yaml';
import { extractBindings, renderValue, type DesiredApp, type DesiredService } from '@swarmy/app-config';
import type { BlueprintParamsInput, CacheEngine } from '@swarmy/core';
import {
  APP_TEMPLATES,
  loadTemplate,
  primaryService,
  templateMeta,
  type AppTemplate,
} from '@swarmy/templates';
import { clusterNetworkName, primaryServiceName, replicaServiceName } from '../manageddb.service';
import { CACHE_PORT, cacheNetworkName, cachePrimaryName } from '../cache.service';
import { autoAddressLabels } from '../auto-address.service';
import { AUTO_ADDRESS_LABEL } from '@swarmy/ingress';
import { ERRORS_ENABLED_LABEL } from '../errors/injection';
import {
  secretToken,
  SIZE_PRESETS,
  TOKEN_DB_PASSWORD,
  TOKEN_DB_URL,
  TOKEN_REDIS_PASSWORD,
  TOKEN_REDIS_URL,
  type BlueprintEntry,
  type PlanEnv,
  type PlanStep,
  type WireAction,
} from './catalog';

/**
 * swarmy.yaml app templates → blueprint plans (the bridge until the git-apps
 * applier lands). A template is parsed + normalised by `@swarmy/app-config`
 * (`loadTemplate` → `DesiredApp`), then compiled onto the SAME step kinds the
 * hand-written blueprints use, so a template deploy runs through the existing
 * executor: managed Postgres/cache provision, generated write-only secrets,
 * `deployFromCompose` (admission + release snapshot), post-deploy wires and
 * the ingress route / auto address.
 *
 * Binding resolution (`${{ … }}`) happens HERE at plan time:
 *  - values that are known and not secret (hosts, ports, db name, app url)
 *    are rendered straight into the compose env;
 *  - anything carrying a credential resolves to an executor token
 *    (`__SWARMY_*__`) and is applied post-deploy as an `env` wire, so the
 *    persisted compose source never holds even a token;
 *  - `FOO_FILE: /run/secrets/<x>` on a service that lists `secrets: [x]` becomes
 *    a `secret` wire (a mounted Docker secret — the value never touches env).
 */

const DB_PORT = '5432';
const DB_USER = 'postgres';

/** Raised when a template can't compile (caller maps to a 400 / test failure). */

/** `${{ secrets.x }}` as the WHOLE value → `x` (a partial embed returns null). */
export function wholeSecretBinding(raw: string): string | null {
  const bs = extractBindings(raw);
  if (bs.length !== 1) return null;
  const b = bs[0]!;
  if (b.ref?.ns !== 'secret') return null;
  const t = raw.trim();
  return t === `\${{ ${b.expr} }}` || t === `\${{${b.expr}}}` ? b.ref.name : null;
}

export class TemplateCompileError extends Error {
  constructor(templateId: string, message: string) {
    super(`template "${templateId}": ${message}`);
    this.name = 'TemplateCompileError';
  }
}

/** Secret family for a template secret: stack-scoped so two installs never collide. */
export function templateSecretFamily(stack: string, name: string): string {
  return `${stack}-${name}`;
}

const TOKEN_MARK = '__SWARMY_';

interface ResourceIndex {
  db?: { name: string; database: string; replicas: number };
  cache?: { name: string };
}

function indexResources(t: AppTemplate, desired: DesiredApp, replicas: number): ResourceIndex {
  const out: ResourceIndex = {};
  for (const r of desired.resources) {
    if (r.type === 'postgres') {
      if (out.db) throw new TemplateCompileError(t.id, 'at most one postgres resource');
      out.db = { name: r.name, database: r.database, replicas };
    } else if (r.type === 'cache') {
      if (out.cache) throw new TemplateCompileError(t.id, 'at most one cache resource');
      out.cache = { name: r.name };
    } else {
      throw new TemplateCompileError(t.id, `resource type "${r.type}" is not supported by templates yet`);
    }
  }
  return out;
}

/** The `refKey → value` map `renderValue` substitutes (tokens for credentials). */
function bindingMap(
  stack: string,
  desired: DesiredApp,
  res: ResourceIndex,
  appDomain: string | null,
): Record<string, string> {
  const m: Record<string, string> = { 'app.name': stack, 'app.environment': 'production' };
  if (appDomain) {
    m['app.domain'] = appDomain;
    m['app.url'] = `https://${appDomain}`;
  }
  if (res.db) {
    const n = res.db.name;
    const host = primaryServiceName(stack, n);
    const roHost = res.db.replicas > 0 ? replicaServiceName(stack, n) : host;
    m[`${n}.host`] = host;
    m[`${n}.ro_host`] = roHost;
    m[`${n}.port`] = DB_PORT;
    m[`${n}.database`] = res.db.database;
    m[`${n}.user`] = DB_USER;
    m[`${n}.password`] = TOKEN_DB_PASSWORD;
    m[`${n}.url`] = TOKEN_DB_URL;
    m[`${n}.ro_url`] = `postgres://${DB_USER}:${TOKEN_DB_PASSWORD}@${roHost}:${DB_PORT}/${res.db.database}`;
  }
  if (res.cache) {
    const n = res.cache.name;
    m[`${n}.host`] = cachePrimaryName(stack, n);
    m[`${n}.port`] = String(CACHE_PORT);
    m[`${n}.password`] = TOKEN_REDIS_PASSWORD;
    m[`${n}.url`] = TOKEN_REDIS_URL;
  }
  for (const s of desired.services) {
    m[`services.${s.name}.host`] = s.name;
    if (s.port !== undefined) {
      m[`services.${s.name}.port`] = String(s.port);
      m[`services.${s.name}.url`] = `http://${s.name}:${s.port}`;
    }
  }
  return m;
}

function seconds(n: number | undefined): string | undefined {
  return n === undefined ? undefined : `${n}s`;
}

function composeHealthcheck(s: DesiredService): Record<string, unknown> | undefined {
  const h = s.healthcheck;
  if (!h) return undefined;
  let test: string[];
  if (h.kind === 'http') {
    const url = `http://127.0.0.1:${h.port}${h.path}`;
    // Templates only use `path` on images that ship wget or curl (authoring rule).
    test = ['CMD-SHELL', `wget -qO /dev/null ${url} 2>/dev/null || curl -fsS -o /dev/null ${url}`];
  } else if (h.command[0] === 'sh' && h.command[1] === '-c' && h.command.length === 3) {
    test = ['CMD-SHELL', h.command[2]!];
  } else {
    test = ['CMD', ...h.command];
  }
  return {
    test,
    ...(h.intervalSeconds !== undefined ? { interval: seconds(h.intervalSeconds) } : {}),
    ...(h.timeoutSeconds !== undefined ? { timeout: seconds(h.timeoutSeconds) } : {}),
    retries: h.retries ?? 5,
    ...(h.startPeriodSeconds !== undefined ? { start_period: seconds(h.startPeriodSeconds) } : {}),
  };
}

export interface CompiledTemplate {
  steps: PlanStep[];
  /** Short name + port of the service that gets the URL. */
  primary: { name: string; port: number } | null;
}

/**
 * Compile one template for `params` into plan steps. PURE. `env.autoHost` is
 * the auto address for the primary service (resolved by the service layer
 * when no domain was given).
 */
export function compileTemplate(
  t: AppTemplate,
  params: BlueprintParamsInput,
  env: PlanEnv = {},
): CompiledTemplate {
  const stack = params.name;
  const loaded = loadTemplate(t, { stack, options: params.options });
  const desired = loaded.desired;
  if (!desired) {
    throw new TemplateCompileError(
      t.id,
      loaded.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }
  const preset = SIZE_PRESETS[params.size];
  const res = indexResources(t, desired, preset.dbReplicas);
  const primary = primaryService(t, desired);
  const isPrivate = t.exposure === 'private';
  const domain = isPrivate ? null : (params.domain ?? env.autoHost ?? null);
  const bindings = bindingMap(stack, desired, res, domain);
  const notes: string[] = [];

  const steps: PlanStep[] = [];
  if (res.db) {
    const pg = desired.resources.find((r) => r.type === 'postgres');
    steps.push({
      kind: 'db.provision',
      label: 'Provision Postgres cluster',
      payload: {
        cluster: res.db.name,
        replicas: res.db.replicas,
        database: res.db.database,
        ...(pg && pg.type === 'postgres' && pg.version !== 16 ? { imageTag: String(pg.version) } : {}),
      },
    });
  }
  if (res.cache) {
    const c = desired.resources.find((r) => r.type === 'cache');
    const queue = c?.type === 'cache' && c.purpose === 'queue';
    steps.push({
      kind: 'cache.provision',
      label: queue ? 'Provision BullMQ queue (Valkey, never evicts)' : 'Provision Valkey cache',
      payload: {
        cluster: res.cache.name,
        engine: (c && c.type === 'cache' ? c.engine : 'valkey') as CacheEngine,
        topology: preset.cacheReplicas > 0 ? 'replica' : 'single',
        memoryMb: c && c.type === 'cache' ? c.memoryMb : 128,
        replicas: preset.cacheReplicas,
        ...(queue ? { purpose: 'queue' as const } : {}),
      },
    });
  }
  for (const [name, gen] of Object.entries(t.generate ?? {})) {
    const family = templateSecretFamily(stack, name);
    bindings[`secrets.${name}`] = secretToken(family);
    steps.push({
      kind: 'secret',
      label: `Generate secret ${family}`,
      payload: { family, token: secretToken(family), format: gen.format, length: gen.length },
    });
  }

  // ── compose + wires ──
  const services: Record<string, unknown> = {};
  const volumes = new Set<string>();
  const externalNets = new Set<string>();
  const wires: WireAction[] = [];
  const missingApp = new Set<string>();
  for (const s of desired.services) {
    if (s.source.kind !== 'image') throw new TemplateCompileError(t.id, `${s.name}: build is not supported`);
    if (s.release) throw new TemplateCompileError(t.id, `${s.name}: release is not supported yet`);
    const composeEnv: Record<string, string> = {};
    const wireEnv: Record<string, string> = {};
    let usesDb = false;
    let usesCache = false;
    for (const [key, raw] of Object.entries(s.env)) {
      const mounted = s.secrets.find((x) => raw === `/run/secrets/${x}`);
      if (mounted) {
        wires.push({ type: 'secret', service: s.name, family: templateSecretFamily(stack, mounted), envName: key });
        continue;
      }
      // `KEY: ${{ secrets.x }}` for a generated secret → exported as $KEY by the
      // secret-env shim from the mounted Docker secret — the generated value
      // never enters the compose, the spec or `docker inspect`.
      const generated = wholeSecretBinding(raw);
      if (generated && t.generate?.[generated] && !t.noShell?.includes(s.name)) {
        wires.push({
          type: 'secret',
          service: s.name,
          family: templateSecretFamily(stack, generated),
          envName: key,
          delivery: 'env',
        });
        continue;
      }
      const { value, missing } = renderValue(raw, bindings);
      const unresolved = missing.filter((k) => !k.startsWith('app.'));
      if (unresolved.length) {
        throw new TemplateCompileError(t.id, `${s.name}.env.${key}: can't resolve ${unresolved.join(', ')}`);
      }
      for (const k of missing) missingApp.add(k);
      // app.* with no domain yet: render empty (after the note below says so).
      const rendered = missing.length ? renderValue(raw, { ...bindings, 'app.url': '', 'app.domain': '' }).value : value;
      for (const b of extractBindings(raw)) {
        if (b.ref?.ns !== 'resource') continue;
        if (b.ref.name === res.db?.name) usesDb = true;
        if (b.ref.name === res.cache?.name) usesCache = true;
      }
      if (rendered.includes(TOKEN_MARK)) wireEnv[key] = rendered;
      else composeEnv[key] = rendered;
    }
    if (Object.keys(wireEnv).length) wires.push({ type: 'env', service: s.name, env: wireEnv });

    const nets = ['default'];
    if (usesDb && res.db) nets.push(clusterNetworkName(stack, res.db.name));
    if (usesCache && res.cache) nets.push(cacheNetworkName(stack, res.cache.name));
    for (const n of nets.slice(1)) externalNets.add(n);

    const svc: Record<string, unknown> = { image: s.source.image };
    if (s.command) svc.command = s.command;
    if (Object.keys(composeEnv).length) svc.environment = composeEnv;
    if (s.volumes.length) {
      svc.volumes = s.volumes.map((v) => `${v.name}:${v.target}`);
      for (const v of s.volumes) volumes.add(v.name);
    }
    svc.networks = nets;
    const hc = composeHealthcheck(s);
    if (hc) svc.healthcheck = hc;
    const limits: Record<string, string> = {};
    if (s.memoryMb !== undefined) limits.memory = `${s.memoryMb}M`;
    if (s.cpu !== undefined) limits.cpus = String(s.cpu);
    svc.deploy = {
      replicas: s.replicas,
      // A template with `errors: true` opts in to error tracking (SENTRY_DSN bound on deploy).
      ...(desired.errors ? { labels: { [ERRORS_ENABLED_LABEL]: 'true' } } : {}),
      ...(Object.keys(limits).length ? { resources: { limits } } : {}),
      // Volumes are node-local: pin stateful services (and every service
      // sharing a volume) to one node so data never comes up empty elsewhere.
      ...(s.volumes.length && env.pinNode
        ? { placement: { constraints: [`node.id==${env.pinNode}`] } }
        : {}),
    };
    services[s.name] = svc;
  }
  if (missingApp.size) {
    notes.push(
      `${[...missingApp].join(' and ')} had no domain yet, so it was left empty. Add a domain to ${primary?.name ?? 'the app'} and redeploy it to set it.`,
    );
  }
  const doc: Record<string, unknown> = { services };
  if (volumes.size) doc.volumes = Object.fromEntries([...volumes].map((v) => [v, null]));
  if (externalNets.size) {
    doc.networks = Object.fromEntries([...externalNets].map((n) => [n, { external: true }]));
  }

  const url = domain ? `https://${domain}` : null;
  for (const r of t.reveal ?? []) {
    notes.push(renderValue(r, bindings).value);
  }
  const internal = primary ? `http://${stack}_${primary.name}:${primary.port}` : '';
  for (const p of t.postDeploy) {
    notes.push(p.replaceAll('<url>', url ?? 'the app URL').replaceAll('<internal>', internal));
  }

  const postLabels: Record<string, Record<string, string>> = {};
  if (isPrivate && primary) {
    postLabels[primary.name] = { [AUTO_ADDRESS_LABEL]: 'false' };
  } else if (!params.domain && env.autoHost && primary) {
    postLabels[primary.name] = autoAddressLabels(env.autoHost, primary.port);
  }
  const names = Object.keys(services);
  steps.push({
    kind: 'stack.deploy',
    label: `Deploy stack ${stack} (${names.length} service${names.length === 1 ? '' : 's'})`,
    payload: {
      composeSource: stringifyYaml(doc),
      services: names,
      ensureNetworks: [],
      postLabels,
      wires,
      notes,
    },
  });
  if (params.domain && primary && !isPrivate) {
    steps.push({
      kind: 'ingress.route',
      label: `Route https://${params.domain} → ${primary.name}:${primary.port}`,
      payload: { service: primary.name, host: params.domain, port: primary.port },
    });
  }
  return { steps, primary };
}

/** Wrap a template as a gallery/deploy entry. */
export function templateEntry(t: AppTemplate): BlueprintEntry {
  const meta = templateMeta(t);
  const loaded = loadTemplate(t, { stack: 'demo' });
  const primary = loaded.desired ? primaryService(t, loaded.desired) : null;
  return {
    meta,
    ...(primary && t.exposure !== 'private' ? { autoAddressService: primary.name } : {}),
    ...(loaded.desired?.services.some((s) => s.volumes.length > 0) ? { pinsVolumes: true } : {}),
    plan: (params, env) => compileTemplate(t, params, env).steps,
  };
}

/** The whole app catalogue as blueprint entries (built once). */
export const TEMPLATE_ENTRIES: BlueprintEntry[] = APP_TEMPLATES.map(templateEntry);
