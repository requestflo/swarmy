/**
 * Cross-field validation of a structurally-valid swarmy.yaml: names don't
 * collide, every `${{ … }}` binding resolves to a declared thing and a field
 * that thing exposes, jobs point at real services, pgvector sits on a real
 * postgres, domains are unique. Errors block the plan; warnings ride along in
 * the PR comment.
 */
import {
  APP_BINDING_FIELDS,
  RESERVED_NAMES,
  EMAIL_FIELDS,
  RESOURCE_BINDING_FIELDS,
  SERVICE_BINDING_FIELDS,
  extractBindings,
} from './bindings';
import { issue, zodToIssues, type ConfigIssue } from './issues';
import { AppConfigSchema, RESERVED_ENV_NAMES, type AppConfig, type ResourceType } from './schema';
import { resolveEnvironment } from './environments';

type ResourceOut = NonNullable<AppConfig['resources']>[string];

export function resourceTypeOf(r: ResourceOut): ResourceType {
  return typeof r === 'string' ? r : r.type;
}

export function domainHost(d: string | { host: string; path?: string }): {
  host: string;
  path: string;
} {
  return typeof d === 'string'
    ? { host: d.toLowerCase(), path: '/' }
    : { host: d.host.toLowerCase(), path: d.path ?? '/' };
}

/** The service a job runs in when it names none: the single built service, if exactly one. */
export function defaultJobService(cfg: AppConfig): string | undefined {
  const built = Object.entries(cfg.services).filter(([, s]) => s.build !== undefined);
  return built.length === 1 ? built[0]?.[0] : undefined;
}

export function validateConfig(cfg: AppConfig): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const services = cfg.services;
  const resources = cfg.resources ?? {};
  const jobs = cfg.jobs ?? {};

  // ── names ──
  for (const [kind, names] of [
    ['services', Object.keys(services)],
    ['resources', Object.keys(resources)],
  ] as const) {
    for (const n of names) {
      if ((RESERVED_NAMES as readonly string[]).includes(n)) {
        out.push(
          issue(
            'error',
            'name/reserved',
            [kind, n],
            `"${n}" is reserved for bindings — pick another name`,
          ),
        );
      }
    }
  }
  for (const n of Object.keys(resources)) {
    if (n in services) {
      out.push(
        issue(
          'error',
          'name/collision',
          ['resources', n],
          `"${n}" is both a service and a resource — names must be unique`,
        ),
      );
    }
  }

  // ── bindings (service env, shared env, job env) ──
  const checkEnv = (
    env: Record<string, string | number | boolean> | undefined,
    base: (string | number)[],
  ) => {
    for (const [k, v] of Object.entries(env ?? {})) {
      if (typeof v !== 'string') continue;
      for (const b of extractBindings(v)) {
        const path = [...base, k];
        if (!b.ref) {
          out.push(issue('error', 'binding/malformed', path, b.error ?? 'malformed binding'));
          continue;
        }
        const ref = b.ref;
        if (ref.ns === 'resource') {
          const r = resources[ref.name];
          if (!r) {
            out.push(
              issue(
                'error',
                'binding/unknown-resource',
                path,
                `no resource named "${ref.name}" (in \${{ ${b.expr} }})`,
              ),
            );
            continue;
          }
          const t = resourceTypeOf(r);
          const fields = RESOURCE_BINDING_FIELDS[t];
          if (!fields.includes(ref.field)) {
            out.push(
              issue(
                'error',
                'binding/unknown-field',
                path,
                `${t} "${ref.name}" has no "${ref.field}" — use one of ${fields.join(', ')}`,
              ),
            );
          }
        } else if (ref.ns === 'service') {
          const s = services[ref.name];
          if (!s) {
            out.push(
              issue('error', 'binding/unknown-service', path, `no service named "${ref.name}"`),
            );
          } else if (!(SERVICE_BINDING_FIELDS as readonly string[]).includes(ref.field)) {
            out.push(
              issue(
                'error',
                'binding/unknown-field',
                path,
                `services have ${SERVICE_BINDING_FIELDS.join(', ')} — not "${ref.field}"`,
              ),
            );
          } else if (s.port === undefined) {
            out.push(
              issue(
                'error',
                'binding/no-port',
                path,
                `service "${ref.name}" has no port to address`,
              ),
            );
          }
        } else if (ref.ns === 'email') {
          // Presence of `email:` and whole-value use are checked in email.ts.
          if (!(EMAIL_FIELDS as readonly string[]).includes(ref.field)) {
            out.push(
              issue('error', 'binding/unknown-field', path, `email has ${EMAIL_FIELDS.join(', ')} — not "${ref.field}"`),
            );
          }
        } else if (ref.ns === 'app') {
          if (!(APP_BINDING_FIELDS as readonly string[]).includes(ref.field)) {
            out.push(
              issue(
                'error',
                'binding/unknown-field',
                path,
                `app has ${APP_BINDING_FIELDS.join(', ')} — not "${ref.field}"`,
              ),
            );
          }
        } else if (v.trim() !== `\${{ ${b.expr} }}` && v.trim() !== `\${{${b.expr}}}`) {
          // `KEY: ${{ secrets.x }}` (the whole value) is delivered by the
          // secret-env shim from the mounted Docker secret — never in the
          // spec. Only an EMBEDDED secret would have to be rendered into env.
          out.push(
            issue(
              'warning',
              'binding/secret-in-env',
              path,
              `secrets.${ref.name} is embedded in a larger value, so it would be rendered into the service env (visible in docker inspect) — give it its own variable: ${k}: \${{ secrets.${ref.name} }}`,
            ),
          );
        }
      }
    }
  };
  checkEnv(cfg.env, ['env']);

  // ── services ──
  const seenDomains = new Map<string, string>();
  for (const [name, s] of Object.entries(services)) {
    const base = ['services', name];
    checkEnv(s.env, [...base, 'env']);
    if (s.healthcheck?.path !== undefined && s.port === undefined) {
      out.push(
        issue(
          'error',
          'service/healthcheck-needs-port',
          [...base, 'healthcheck'],
          'an HTTP healthcheck needs a port',
        ),
      );
    }
    (s.domains ?? []).forEach((d, i) => {
      const { host, path } = domainHost(d);
      const key = `${host}${path}`;
      if (s.port === undefined) {
        out.push(
          issue(
            'error',
            'domain/needs-port',
            [...base, 'domains', i],
            `${host} needs the service to declare a port`,
          ),
        );
      }
      const prev = seenDomains.get(key);
      if (prev) {
        out.push(
          issue(
            'error',
            'domain/duplicate',
            [...base, 'domains', i],
            `${key} is already routed to "${prev}"`,
          ),
        );
      } else {
        seenDomains.set(key, name);
      }
    });
    if (s.sleep_after !== undefined && !(s.domains ?? []).length) {
      out.push(
        issue(
          'warning',
          'service/sleep-without-domain',
          [...base, 'sleep_after'],
          'scale-to-zero wakes on an HTTP request — without a domain nothing will wake it',
        ),
      );
    }
    if (s.size !== undefined && (s.cpu !== undefined || s.memory !== undefined)) {
      out.push(
        issue(
          'warning',
          'service/size-overridden',
          [...base, 'size'],
          'cpu/memory override the size preset',
        ),
      );
    }
    if (s.image !== undefined && /:latest$|^[^:@]+$/.test(s.image.split('/').pop() ?? '')) {
      out.push(
        issue(
          'warning',
          'service/floating-tag',
          [...base, 'image'],
          'pin a tag or digest — swarmy resolves and deploys by digest, and :latest makes rollbacks meaningless',
        ),
      );
    }
  }

  // ── resources ──
  for (const [name, r] of Object.entries(resources)) {
    if (typeof r === 'string') continue;
    const base = ['resources', name];
    if (r.type === 'postgres') {
      if (r.ha === 'geo' && !r.regions) {
        out.push(
          issue(
            'error',
            'postgres/geo-needs-regions',
            [...base, 'regions'],
            'ha: geo needs regions: { <region>: <replicas> }',
          ),
        );
      }
      if (r.regions && r.ha !== 'geo') {
        out.push(
          issue(
            'warning',
            'postgres/regions-ignored',
            [...base, 'regions'],
            'regions only apply with ha: geo',
          ),
        );
      }
      if (r.ha === 'single' && (r.replicas ?? 0) > 0) {
        out.push(
          issue(
            'warning',
            'postgres/single-replicas',
            [...base, 'replicas'],
            'ha: single runs no replicas',
          ),
        );
      }
    } else if (r.type === 'cache' || r.type === 'queue') {
      if (r.ha === 'sentinel' && r.replicas === 0) {
        out.push(
          issue(
            'error',
            'cache/sentinel-needs-replica',
            [...base, 'replicas'],
            'sentinel needs at least 1 replica to fail over to',
          ),
        );
      }
    } else if (r.type === 'vector') {
      const engine = r.engine ?? (r.on ? 'pgvector' : 'qdrant');
      if (engine === 'pgvector') {
        const target = r.on ? resources[r.on] : undefined;
        if (!r.on) {
          out.push(
            issue(
              'error',
              'vector/pgvector-needs-on',
              [...base, 'on'],
              'pgvector needs on: <postgres resource>',
            ),
          );
        } else if (!target || resourceTypeOf(target) !== 'postgres') {
          out.push(
            issue(
              'error',
              'vector/on-not-postgres',
              [...base, 'on'],
              `"${r.on}" is not a postgres resource`,
            ),
          );
        }
      } else if (r.on) {
        out.push(
          issue(
            'warning',
            'vector/on-ignored',
            [...base, 'on'],
            'on: only applies to engine: pgvector',
          ),
        );
      }
    } else if (r.type === 'bucket' && r.access === 'public') {
      out.push(
        issue(
          'warning',
          'bucket/public',
          [...base, 'access'],
          'a public bucket is world-readable — every object, forever cached',
        ),
      );
    }
  }

  // ── jobs ──
  for (const [name, j] of Object.entries(jobs)) {
    const base = ['jobs', name];
    checkEnv(j.env, [...base, 'env']);
    if (j.image === undefined) {
      const svc = j.service ?? defaultJobService(cfg);
      if (!svc) {
        out.push(
          issue(
            'error',
            'job/needs-service',
            base,
            'name the service whose image this job runs in (service:), or give an image:',
          ),
        );
      } else if (!services[svc]) {
        out.push(
          issue('error', 'job/unknown-service', [...base, 'service'], `no service named "${svc}"`),
        );
      }
    }
  }

  // ── previews ──
  if (
    cfg.previews?.enabled &&
    cfg.previews.resources === 'shared' &&
    Object.keys(resources).length
  ) {
    out.push(
      issue(
        'warning',
        'previews/shared-resources',
        ['previews', 'resources'],
        'previews will read and write your production data',
      ),
    );
  }

  // ── previews: branches + data ──
  const pv = cfg.previews;
  if (pv?.data) {
    const from = pv.data.from;
    if (from !== 'production' && !(cfg.environments ?? {})[from]) {
      out.push(
        issue(
          'error',
          'previews/data-from',
          ['previews', 'data', 'from'],
          `"${from}" is not production or an environment in this file`,
        ),
      );
    }
    if (!Object.values(resources).some((r) => resourceTypeOf(r) === 'postgres')) {
      out.push(
        issue(
          'warning',
          'previews/data-no-postgres',
          ['previews', 'data'],
          'previews.data copies Postgres — this app declares none',
        ),
      );
    }
    if (pv.resources === 'shared') {
      out.push(
        issue(
          'error',
          'previews/data-shared',
          ['previews', 'data'],
          'previews.data needs isolated preview resources (it copies INTO them)',
        ),
      );
    }
  }
  (pv?.branches ?? []).forEach((b, i) => {
    if (!/^[A-Za-z0-9*?._/-]+$/.test(b)) {
      out.push(
        issue(
          'error',
          'previews/branch-pattern',
          ['previews', 'branches', i],
          `"${b}" is not a branch pattern (letters, digits, / . _ - * ?)`,
        ),
      );
    }
  });
  if (pv?.branches?.length && !pv.enabled) {
    out.push(
      issue(
        'warning',
        'previews/branches-off',
        ['previews', 'branches'],
        'previews.enabled is false — no branch previews will deploy',
      ),
    );
  }

  // ── environments ──
  const envs = cfg.environments ?? {};
  const branches = new Map<string, string>();
  const allHosts = new Map<string, string>(); // host+path → where
  for (const [svc, s] of Object.entries(services)) {
    for (const d of s.domains ?? []) {
      const { host, path } = domainHost(d);
      allHosts.set(`${host}${path}`, `production ${svc}`);
    }
  }
  for (const [envName, e] of Object.entries(envs)) {
    const base = ['environments', envName];
    if ((RESERVED_ENV_NAMES as readonly string[]).includes(envName)) {
      out.push(
        issue(
          'error',
          'env/reserved',
          base,
          `"${envName}" is reserved — production is the file itself`,
        ),
      );
      continue;
    }
    const dupe = branches.get(e.branch);
    if (dupe) {
      out.push(
        issue(
          'error',
          'env/branch-taken',
          [...base, 'branch'],
          `branch ${e.branch} already deploys environment "${dupe}"`,
        ),
      );
    }
    branches.set(e.branch, envName);
    for (const n of Object.keys(e.services ?? {})) {
      if (!services[n])
        out.push(
          issue(
            'error',
            'env/unknown-service',
            [...base, 'services', n],
            `no service named "${n}"`,
          ),
        );
    }
    for (const n of Object.keys(e.resources ?? {})) {
      if (!resources[n])
        out.push(
          issue(
            'error',
            'env/unknown-resource',
            [...base, 'resources', n],
            `no resource named "${n}"`,
          ),
        );
    }
    for (const [svc, o] of Object.entries(e.services ?? {})) {
      (o.domains ?? []).forEach((d, i) => {
        const { host, path } = domainHost(d);
        const key = `${host}${path}`;
        const prev = allHosts.get(key);
        if (prev) {
          out.push(
            issue(
              'error',
              'env/domain-taken',
              [...base, 'services', svc, 'domains', i],
              `${key} is already routed to ${prev}`,
            ),
          );
        } else {
          allHosts.set(key, `${envName} ${svc}`);
        }
      });
    }
    if (
      out.some(
        (i) => i.severity === 'error' && i.path[0] === 'environments' && i.path[1] === envName,
      )
    )
      continue;
    // The merged environment must itself be a valid app (e.g. an `ha:` its resource type allows).
    const merged = AppConfigSchema.safeParse(resolveEnvironment(cfg, envName));
    if (!merged.success) {
      for (const zi of merged.error.issues.flatMap(zodToIssues)) {
        const p = zi.path[0] === 'resources' || zi.path[0] === 'services' ? zi.path : [];
        out.push(issue('error', 'env/invalid', [...base, ...p], `${envName}: ${zi.message}`));
      }
      continue;
    }
    for (const i of validateConfig({ ...merged.data, environments: undefined })) {
      // Errors only (prod warnings would repeat per environment); cross-env domains are checked above.
      if (i.severity !== 'error' || i.code === 'domain/duplicate') continue;
      out.push({ ...i, path: [...base, ...i.path], message: `${envName}: ${i.message}` });
    }
  }

  return out;
}
