/**
 * DesiredApp services → the compose file the apply loop deploys, plus the
 * post-deploy attachments that carry credentials (pure).
 *
 * Binding resolution splits in two, so a credential NEVER lands in the
 * persisted compose source (the Stack row / Release snapshot):
 *   - addressing fields (hosts, ports, database, bucket, endpoint, app.*) are
 *     rendered straight into the compose env;
 *   - credential fields (postgres url/ro_url, cache url/password_file,
 *     search key_file, vector url, bucket keys) become ATTACHMENTS — the same
 *     `injectConnection` / `attachCacheToService` / … calls the Data tab
 *     makes, which mint/mount the secret and stamp the inject marker, so every
 *     later compose deploy carries the wiring (attachment-carry.ts).
 * Attachments name their env var after the binding's key, so
 * `DATABASE_URL: ${{ db.url }}` wires exactly `DATABASE_URL`. Where an attach
 * flow's var name is fixed (search keys, S3 keys) the binding must use that
 * name, and a mismatch is a located error rather than a silently-different
 * variable.
 */
import { stringify as stringifyYaml } from 'yaml';
import {
  SCALE_TO_ZERO_IDLE_LABEL,
  SCALE_TO_ZERO_LABEL,
  SCALE_TO_ZERO_TARGET_LABEL,
} from '@swarmy/core';
import {
  extractBindings,
  renderValue,
  type ConfigIssue,
  type DesiredApp,
  type DesiredResource,
  type DesiredService,
} from '@swarmy/app-config';
import { primaryServiceName, replicaServiceName, roVarName } from '../manageddb.service';
import { CACHE_PORT, cachePasswordFileVar, cachePrimaryName } from '../cache.service';
import { SEARCH_PORTS, searchServiceName } from '../search.service';
import { VECTOR_PORT, vectorServiceName } from '../vector.service';
import { GARAGE_S3_UPSTREAM } from '../bucket-access.service';
import { DEPLOY_SAFETY_LABEL } from '../releases.service';
import {
  APP_BUILD_LABEL,
  APP_COMMIT_LABEL,
  APP_ENV_LABEL,
  APP_SERVICE_LABEL,
  APP_SIG_LABEL,
  APP_STACK_LABEL,
} from './live';

export const PG_PORT = 5432;
export const PG_USER = 'postgres';
export const S3_REGION = 'swarmy';
/** Owner decision: a push deploys immediately, health-gated with auto-rollback. */
export const APP_HEALTH_GATE = { windowSec: 120, autoRollback: true };

export type Attachment =
  | { kind: 'db'; service: string; cluster: string; envVar: string }
  | { kind: 'cache'; service: string; cluster: string; envVar: string }
  | { kind: 'search'; service: string; name: string }
  | { kind: 'vector'; service: string; name: string; envVar: string }
  | { kind: 'bucket'; service: string; resource: string }
  /** Mounted at /run/secrets/<family>; with `envName`, exported as $envName by the secret-env shim. */
  | { kind: 'secret'; service: string; family: string; envName?: string };

/** Stable id for the ledger (`db:db:DATABASE_URL`). */
export function attachmentKey(a: Attachment): string {
  switch (a.kind) {
    case 'db':
    case 'cache':
      return `${a.kind}:${a.cluster}:${a.envVar}`;
    case 'search':
      return `search:${a.name}`;
    case 'vector':
      return `vector:${a.name}:${a.envVar}`;
    case 'bucket':
      return `bucket:${a.resource}`;
    case 'secret':
      return a.envName ? `secret:${a.family}:${a.envName}` : `secret:${a.family}`;
  }
}

/** Org-global bucket name for an app resource. */
export function appBucketName(stack: string, resource: string): string {
  return `${stack}-${resource}`.toLowerCase().slice(0, 63).replace(/-+$/, '');
}

const CREDENTIAL_FIELDS: Record<DesiredResource['type'], readonly string[]> = {
  postgres: ['url', 'ro_url', 'password'],
  cache: ['url', 'password', 'password_file'],
  search: ['key_file'],
  vector: ['url'],
  bucket: ['access_key_id', 'secret_access_key_file'],
};

/** The addressing values a binding may render into compose (never a credential). */
export function addressingMap(d: DesiredApp): Record<string, string> {
  const m: Record<string, string> = { 'app.name': d.app, 'app.environment': d.environment };
  const primaryRoute = d.routes[0];
  if (primaryRoute) {
    m['app.domain'] = primaryRoute.host;
    m['app.url'] = `https://${primaryRoute.host}`;
  }
  const byName = new Map(d.resources.map((r) => [r.name, r]));
  for (const r of d.resources) {
    const n = r.name;
    if (r.type === 'postgres') {
      const host = primaryServiceName(d.stack, n);
      m[`${n}.host`] = host;
      m[`${n}.ro_host`] = r.replicas > 0 ? replicaServiceName(d.stack, n) : host;
      m[`${n}.port`] = String(PG_PORT);
      m[`${n}.database`] = r.database;
      m[`${n}.user`] = PG_USER;
    } else if (r.type === 'cache') {
      m[`${n}.host`] = cachePrimaryName(d.stack, n);
      m[`${n}.port`] = String(CACHE_PORT);
    } else if (r.type === 'search') {
      const host = searchServiceName(d.stack, n);
      const port = SEARCH_PORTS[r.engine as keyof typeof SEARCH_PORTS] ?? SEARCH_PORTS.meilisearch;
      m[`${n}.host`] = host;
      m[`${n}.port`] = String(port);
      m[`${n}.url`] = `http://${host}:${port}`;
    } else if (r.type === 'vector') {
      if (r.engine === 'pgvector' && r.on) {
        const pg = byName.get(r.on);
        m[`${n}.host`] = primaryServiceName(d.stack, r.on);
        m[`${n}.port`] = String(PG_PORT);
        void pg;
      } else {
        m[`${n}.host`] = vectorServiceName(d.stack, n);
        m[`${n}.port`] = String(VECTOR_PORT);
      }
    } else if (r.type === 'bucket') {
      m[`${n}.endpoint`] = `http://${GARAGE_S3_UPSTREAM}`;
      m[`${n}.bucket`] = appBucketName(d.stack, n);
      m[`${n}.region`] = S3_REGION;
    }
  }
  for (const s of d.services) {
    m[`services.${s.name}.host`] = s.name;
    if (s.port !== undefined) {
      m[`services.${s.name}.port`] = String(s.port);
      m[`services.${s.name}.url`] = `http://${s.name}:${s.port}`;
    }
  }
  return m;
}

export interface CompiledServices {
  composeSource: string;
  attachments: Attachment[];
  issues: ConfigIssue[];
}

const err = (path: (string | number)[], code: string, message: string): ConfigIssue => ({
  severity: 'error',
  code,
  path,
  message,
});

/**
 * Compile the services to deploy. `images` maps service name → the image ref
 * to run (a pinned digest for builds). `only` limits the compose to those
 * services (a partial deploy still names every app service it touches).
 * `replicasOverride` lets the first deploy of a service with a release command
 * start at 0 replicas until the release has run.
 */
export function compileServices(
  d: DesiredApp,
  images: Record<string, string>,
  opts: { commit?: string; only?: string[]; replicasOverride?: Record<string, number> } = {},
): CompiledServices {
  const addressing = addressingMap(d);
  const resources = new Map(d.resources.map((r) => [r.name, r]));
  const attachments: Attachment[] = [];
  const issues: ConfigIssue[] = [];
  const services: Record<string, unknown> = {};
  const volumes = new Set<string>();

  for (const s of d.services) {
    if (opts.only && !opts.only.includes(s.name)) continue;
    const image = images[s.name];
    if (!image) {
      issues.push(
        err(['services', s.name], 'apply/no-image', `no image for ${s.name} (build missing)`),
      );
      continue;
    }
    const env: Record<string, string> = {};
    for (const [key, raw] of Object.entries(s.env)) {
      const path = ['services', s.name, 'env', key];
      const credential = extractBindings(raw).filter(
        (b) =>
          b.ref?.ns === 'secret' ||
          (b.ref?.ns === 'resource' &&
            (CREDENTIAL_FIELDS[resources.get(b.ref.name)?.type ?? 'bucket'] ?? []).includes(
              b.ref.field,
            )),
      );
      if (!credential.length) {
        const { value, missing } = renderValue(raw, addressing);
        if (missing.length) {
          issues.push(
            err(
              path,
              'apply/unresolved',
              `${missing.join(', ')} has no value yet${missing.some((k) => k.startsWith('app.')) ? ' — add a domain' : ''}`,
            ),
          );
          continue;
        }
        env[key] = value;
        continue;
      }
      const b = credential[0]!;
      const whole = raw.trim() === `\${{ ${b.expr} }}` || raw.trim() === `\${{${b.expr}}}`;
      if (!whole || credential.length > 1) {
        issues.push(
          err(
            path,
            'apply/credential-embedded',
            `${b.expr} carries a credential — give it its own variable: ${key}: \${{ ${b.expr} }}`,
          ),
        );
        continue;
      }
      const ref = b.ref!;
      if (ref.ns === 'secret') {
        // Env delivery through the secret-env shim: mounted at
        // /run/secrets/<KEY>, exported as $KEY at start — the value never
        // enters the compose or the service spec.
        attachments.push({ kind: 'secret', service: s.name, family: ref.name, envName: key });
        continue;
      }
      if (ref.ns !== 'resource') continue;
      const r = resources.get(ref.name);
      if (!r) continue;
      const a = credentialAttachment(s, key, r, ref.field, d, issues, path);
      if (
        a &&
        !attachments.some((x) => x.service === a.service && attachmentKey(x) === attachmentKey(a))
      )
        attachments.push(a);
    }
    for (const family of s.secrets) attachments.push({ kind: 'secret', service: s.name, family });

    const labels: Record<string, string> = {
      [APP_STACK_LABEL]: d.stack,
      [APP_SERVICE_LABEL]: s.name,
      [APP_SIG_LABEL]: s.sig,
      [APP_ENV_LABEL]: d.environment,
      [DEPLOY_SAFETY_LABEL]: JSON.stringify(APP_HEALTH_GATE),
      ...(s.source.kind === 'build' ? { [APP_BUILD_LABEL]: s.source.key } : {}),
      ...(opts.commit ? { [APP_COMMIT_LABEL]: opts.commit } : {}),
      ...(s.sleepAfterSeconds !== undefined
        ? {
            [SCALE_TO_ZERO_LABEL]: 'true',
            [SCALE_TO_ZERO_TARGET_LABEL]: String(Math.max(1, s.replicas)),
            [SCALE_TO_ZERO_IDLE_LABEL]: String(s.sleepAfterSeconds),
          }
        : {}),
    };
    const svc: Record<string, unknown> = { image };
    if (s.command) svc.command = s.command;
    if (Object.keys(env).length) svc.environment = env;
    if (s.volumes.length) {
      svc.volumes = s.volumes.map((v) => `${s.name}-${v.name}:${v.target}`);
      for (const v of s.volumes) volumes.add(`${s.name}-${v.name}`);
    }
    const hc = composeHealthcheck(s);
    if (hc) svc.healthcheck = hc;
    const limits: Record<string, string> = {};
    if (s.memoryMb !== undefined) limits.memory = `${s.memoryMb}M`;
    if (s.cpu !== undefined) limits.cpus = String(s.cpu);
    const constraints = Object.entries(s.placement.labels).map(
      ([k, v]) => `node.labels.${k}==${v}`,
    );
    const preferences: Array<Record<string, string>> = [];
    if (s.placement.regions.length === 1)
      constraints.push(`node.labels.swarmy.region==${s.placement.regions[0]}`);
    else if (s.placement.regions.length > 1) {
      // Swarm constraints AND together — "any of these regions" is a spread preference.
      preferences.push({ spread: 'node.labels.swarmy.region' });
      issues.push({
        severity: 'warning',
        code: 'apply/regions-spread',
        path: ['services', s.name, 'regions'],
        message: `${s.name} spreads across regions instead of pinning (Swarm can't express "any of ${s.placement.regions.join(', ')}")`,
      });
    }
    svc.deploy = {
      replicas: opts.replicasOverride?.[s.name] ?? s.replicas,
      labels: labels,
      ...(Object.keys(limits).length ? { resources: { limits } } : {}),
      ...(constraints.length || preferences.length
        ? {
            placement: {
              ...(constraints.length ? { constraints } : {}),
              ...(preferences.length ? { preferences } : {}),
            },
          }
        : {}),
    };
    services[s.name] = svc;
  }

  const doc: Record<string, unknown> = { services };
  if (volumes.size) doc.volumes = Object.fromEntries([...volumes].sort().map((v) => [v, null]));
  return { composeSource: stringifyYaml(doc), attachments, issues };
}

function credentialAttachment(
  s: DesiredService,
  key: string,
  r: DesiredResource,
  field: string,
  d: DesiredApp,
  issues: ConfigIssue[],
  path: (string | number)[],
): Attachment | null {
  const svc = s.name;
  const urlKeyFor = (predicate: (k: string) => boolean) => Object.keys(s.env).find(predicate);
  switch (r.type) {
    case 'postgres': {
      if (field === 'password') {
        issues.push(
          err(
            path,
            'apply/credential-field',
            `use ${r.name}.url — swarmy injects the password inside the URL, never on its own`,
          ),
        );
        return null;
      }
      if (field === 'ro_url') {
        const urlKey = urlKeyFor((k) => s.env[k]?.includes(`${r.name}.url`) ?? false);
        if (!urlKey || roVarName(urlKey) !== key) {
          issues.push(
            err(
              path,
              'apply/ro-url-name',
              `${r.name}.ro_url is injected as ${urlKey ? roVarName(urlKey) : '<URL var>_RO_URL'} next to ${r.name}.url — rename this variable`,
            ),
          );
        }
        return null; // the url attachment wires it
      }
      return { kind: 'db', service: svc, cluster: r.name, envVar: key };
    }
    case 'cache':
      if (field === 'password') {
        issues.push(
          err(
            path,
            'apply/credential-field',
            `use ${r.name}.url (the password rides a mounted file: ${r.name}.password_file)`,
          ),
        );
        return null;
      }
      if (field === 'password_file') {
        const urlKey = urlKeyFor((k) => s.env[k]?.includes(`${r.name}.url`) ?? false);
        if (!urlKey || cachePasswordFileVar(urlKey) !== key) {
          issues.push(
            err(
              path,
              'apply/password-file-name',
              `${r.name}.password_file is injected as ${urlKey ? cachePasswordFileVar(urlKey) : '<URL var>_PASSWORD_FILE'} next to ${r.name}.url — rename this variable`,
            ),
          );
        }
        return null;
      }
      return { kind: 'cache', service: svc, cluster: r.name, envVar: key };
    case 'search': {
      const want = r.engine === 'typesense' ? 'TYPESENSE_API_KEY_FILE' : 'MEILI_MASTER_KEY_FILE';
      if (key !== want)
        issues.push(
          err(
            path,
            'apply/key-file-name',
            `${r.name}.key_file is injected as ${want} — rename this variable`,
          ),
        );
      return { kind: 'search', service: svc, name: r.name };
    }
    case 'vector':
      if (r.engine === 'pgvector' && r.on)
        return { kind: 'db', service: svc, cluster: r.on, envVar: key };
      return { kind: 'vector', service: svc, name: r.name, envVar: key };
    case 'bucket': {
      const want = field === 'access_key_id' ? 'S3_ACCESS_KEY_ID' : 'S3_SECRET_ACCESS_KEY_FILE';
      if (key !== want)
        issues.push(
          err(
            path,
            'apply/s3-key-name',
            `${r.name}.${field} is injected as ${want} — rename this variable`,
          ),
        );
      return { kind: 'bucket', service: svc, resource: r.name };
    }
  }
  void d;
  return null;
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
    retries: h.retries ?? 3,
    ...(h.startPeriodSeconds !== undefined ? { start_period: seconds(h.startPeriodSeconds) } : {}),
  };
}
