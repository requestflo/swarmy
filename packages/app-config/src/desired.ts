/**
 * Normalise a validated swarmy.yaml into the fully-defaulted `DesiredApp` —
 * the one shape the planner diffs and the controller applies. Every default
 * swarmy fills in lives HERE, so "what does an omitted key mean" has one answer.
 *
 * A preview (`opts.preview`) is the same app re-targeted: its own stack
 * (`<app>-pr<N>`), throwaway resources (single, no replicas, no backups),
 * `pr-<N>.<base>` hosts, at most 1 replica that sleeps when idle, and no cron.
 */
import { extractBindings, refKey } from './bindings';
import { signature } from './hash';
import {
  DEFAULT_POSTGRES_VERSION,
  SIZE_PRESETS,
  type AppConfig,
  type BucketAccess,
  type PostgresHa,
} from './schema';
import { parseDuration, parseRate, parseSizeMb } from './units';
import { defaultJobService, domainHost } from './validate';

export const DEFAULT_PREVIEW_TTL_SECONDS = 72 * 3600;
export const DEFAULT_JOB_TIMEOUT_SECONDS = 600;
export const PREVIEW_SLEEP_AFTER_SECONDS = 30 * 60;

export interface BuildSource {
  kind: 'build';
  /** Signature of the build inputs — services sharing a key share one build. */
  key: string;
  context: string;
  dockerfile: string;
  target?: string;
  args: Record<string, string>;
  /** Changed paths under any of these trigger a rebuild. */
  watch: string[];
}
export interface ImageSource {
  kind: 'image';
  image: string;
}

export type DesiredHealthcheck = (
  | { kind: 'http'; path: string; port: number }
  | { kind: 'command'; command: string[] }
) & {
  intervalSeconds?: number;
  timeoutSeconds?: number;
  retries?: number;
  startPeriodSeconds?: number;
};

export interface DesiredService {
  name: string;
  /** Swarm service name: `<stack>_<name>` (docker stack deploy semantics). */
  serviceName: string;
  source: BuildSource | ImageSource;
  command?: string[];
  port?: number;
  replicas: number;
  sleepAfterSeconds?: number;
  cpu?: number;
  memoryMb?: number;
  healthcheck?: DesiredHealthcheck;
  /** Env templates; bindings still unrendered (`${{ db.url }}`). */
  env: Record<string, string>;
  /** Every binding key the env uses (`db.url`, `services.api.url`). */
  bindings: string[];
  secrets: string[];
  volumes: { name: string; volumeName: string; target: string }[];
  placement: { regions: string[]; labels: Record<string, string> };
  /** Resources + services this service's env references (apply ordering). */
  dependsOn: string[];
  sig: string;
}

export type DesiredResource = { name: string; sig: string } & (
  | {
      type: 'postgres';
      version: number;
      ha: PostgresHa;
      replicas: number;
      regions?: Record<string, number>;
      database: string;
      backups: { schedule: string; keep: number } | null;
    }
  | { type: 'cache'; engine: string; ha: string; replicas: number; memoryMb: number }
  | { type: 'search'; engine: string }
  | { type: 'vector'; engine: 'qdrant' | 'pgvector'; on?: string }
  | { type: 'bucket'; access: BucketAccess; quotaMb?: number }
);

/** Mirrors the ingress `RouteProtectionSchema` field names (camelCase). */
export interface DesiredProtection {
  rateLimit?: { requests: number; windowSeconds: number };
  ipAllow?: string[];
  ipDeny?: string[];
  countryAllow?: string[];
  countryDeny?: string[];
  blockBots?: boolean;
  bodyMaxSize?: string;
  waf?: boolean;
  cacheTtlSeconds?: number;
}

export interface DesiredRoute {
  host: string;
  path: string;
  service: string;
  port: number;
  stripPath: boolean;
  protection?: DesiredProtection;
  sig: string;
}

export interface DesiredJob {
  name: string;
  schedule: string;
  service?: string;
  image?: string;
  command: string[];
  timeoutSeconds: number;
  retries: number;
  env: Record<string, string>;
  sig: string;
}

export interface DesiredApp {
  app: string;
  stack: string;
  preview?: { pr: number };
  /** Previews with `resources: shared` bind to the prod app's resources. */
  sharedResourcesFrom?: string;
  services: DesiredService[];
  resources: DesiredResource[];
  routes: DesiredRoute[];
  jobs: DesiredJob[];
  /** Peer apps linked by a private per-pair overlay (none for previews). */
  connect: string[];
  previews: {
    enabled: boolean;
    ttlSeconds: number;
    baseDomain?: string;
    resources: 'isolated' | 'shared';
  };
}

export interface DesiredOptions {
  preview?: { pr: number; baseDomain: string };
}

const toCommand = (c: string | string[] | undefined): string[] | undefined =>
  c === undefined ? undefined : typeof c === 'string' ? ['sh', '-c', c] : [...c];

const strEnv = (e: Record<string, string | number | boolean> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(e ?? {}).map(([k, v]) => [k, String(v)]));

const sortByName = <T extends { name: string }>(xs: T[]): T[] =>
  xs.sort((a, b) => (a.name < b.name ? -1 : 1));

const withSig = <T extends object>(unit: T): T & { sig: string } => ({
  ...unit,
  sig: signature(unit),
});

export function previewStack(app: string, pr: number): string {
  return `${app}-pr${pr}`;
}

export function toDesired(cfg: AppConfig, opts: DesiredOptions = {}): DesiredApp {
  const preview = opts.preview;
  const stack = preview ? previewStack(cfg.app, preview.pr) : cfg.app;
  const previewsCfg = {
    enabled: cfg.previews?.enabled ?? false,
    ttlSeconds:
      cfg.previews?.ttl !== undefined
        ? (parseDuration(cfg.previews.ttl) ?? 0)
        : DEFAULT_PREVIEW_TTL_SECONDS,
    baseDomain: cfg.previews?.base_domain,
    resources: cfg.previews?.resources ?? 'isolated',
  } as const;
  const shared = preview !== undefined && previewsCfg.resources === 'shared';
  const resourceNames = new Set(Object.keys(cfg.resources ?? {}));
  const serviceNames = new Set(Object.keys(cfg.services));

  // ── resources ──
  const resources: DesiredResource[] = shared
    ? []
    : sortByName(
        Object.entries(cfg.resources ?? {}).map(([name, raw]): DesiredResource => {
          const r = typeof raw === 'string' ? ({ type: raw } as Exclude<typeof raw, string>) : raw;
          switch (r.type) {
            case 'postgres': {
              let ha: PostgresHa = r.ha ?? 'primary-replica';
              let replicas = ha === 'single' ? 0 : (r.replicas ?? 1);
              let backups: { schedule: string; keep: number } | null =
                r.backups === false
                  ? null
                  : { schedule: r.backups?.schedule ?? 'daily', keep: r.backups?.keep ?? 7 };
              let regions = ha === 'geo' ? r.regions : undefined;
              if (preview) {
                ha = 'single';
                replicas = 0;
                backups = null;
                regions = undefined;
              }
              return withSig({
                name,
                type: 'postgres',
                version: r.version ?? DEFAULT_POSTGRES_VERSION,
                ha,
                replicas,
                ...(regions ? { regions } : {}),
                database: r.database ?? name.replace(/-/g, '_'),
                backups,
              });
            }
            case 'cache': {
              const ha = preview ? 'single' : (r.ha ?? 'single');
              const replicas = ha === 'single' ? 0 : (r.replicas ?? 1);
              return withSig({
                name,
                type: 'cache',
                engine: r.engine ?? 'valkey',
                ha,
                replicas,
                memoryMb: r.memory !== undefined ? (parseSizeMb(r.memory) ?? 256) : 256,
              });
            }
            case 'search':
              return withSig({ name, type: 'search', engine: r.engine ?? 'meilisearch' });
            case 'vector': {
              const engine = r.engine ?? (r.on ? 'pgvector' : 'qdrant');
              return withSig({
                name,
                type: 'vector',
                engine,
                ...(engine === 'pgvector' && r.on ? { on: r.on } : {}),
              });
            }
            case 'bucket': {
              const quotaMb =
                r.quota !== undefined ? (parseSizeMb(r.quota) ?? undefined) : undefined;
              return withSig({
                name,
                type: 'bucket',
                access: preview ? 'internal' : (r.access ?? 'internal'),
                ...(quotaMb ? { quotaMb } : {}),
              });
            }
          }
        }),
      );

  // ── services ──
  const services = sortByName(
    Object.entries(cfg.services).map(([name, s]): DesiredService => {
      let source: BuildSource | ImageSource;
      if (s.build !== undefined) {
        const b = typeof s.build === 'string' ? { path: s.build } : s.build;
        const context = normPath(b.path ?? '.');
        const inputs = {
          context,
          dockerfile: 'dockerfile' in b && b.dockerfile ? b.dockerfile : 'Dockerfile',
          ...('target' in b && b.target ? { target: b.target } : {}),
          args: ('args' in b && b.args) || {},
          watch: ('watch' in b && b.watch ? b.watch.map(normPath) : [context]).sort(),
        };
        source = { kind: 'build', key: signature(inputs), ...inputs };
      } else {
        source = { kind: 'image', image: s.image ?? '' };
      }

      const env = { ...strEnv(cfg.env), ...strEnv(s.env) };
      const bindings = new Set<string>();
      const dependsOn = new Set<string>();
      for (const v of Object.values(env)) {
        for (const b of extractBindings(v)) {
          if (!b.ref) continue;
          bindings.add(refKey(b.ref));
          if (b.ref.ns === 'resource' && resourceNames.has(b.ref.name)) dependsOn.add(b.ref.name);
          if (b.ref.ns === 'service' && serviceNames.has(b.ref.name) && b.ref.name !== name)
            dependsOn.add(b.ref.name);
        }
      }

      const preset = s.size ? SIZE_PRESETS[s.size] : undefined;
      const cpu = s.cpu ?? preset?.cpu;
      const memoryMb =
        s.memory !== undefined ? (parseSizeMb(s.memory) ?? undefined) : preset?.memoryMb;

      let healthcheck: DesiredHealthcheck | undefined;
      if (s.healthcheck) {
        const h = s.healthcheck;
        const timing = {
          ...(h.interval !== undefined
            ? { intervalSeconds: parseDuration(h.interval) ?? undefined }
            : {}),
          ...(h.timeout !== undefined
            ? { timeoutSeconds: parseDuration(h.timeout) ?? undefined }
            : {}),
          ...(h.retries !== undefined ? { retries: h.retries } : {}),
          ...(h.start_period !== undefined
            ? { startPeriodSeconds: parseDuration(h.start_period) ?? undefined }
            : {}),
        };
        healthcheck =
          h.path !== undefined && s.port !== undefined
            ? { kind: 'http', path: h.path, port: s.port, ...timing }
            : { kind: 'command', command: toCommand(h.command) ?? [], ...timing };
      }

      let replicas = s.replicas ?? 1;
      let sleepAfterSeconds =
        s.sleep_after !== undefined ? (parseDuration(s.sleep_after) ?? undefined) : undefined;
      if (preview) {
        replicas = Math.min(replicas, 1);
        if ((s.domains ?? []).length)
          sleepAfterSeconds = sleepAfterSeconds ?? PREVIEW_SLEEP_AFTER_SECONDS;
      }

      const unit = {
        name,
        serviceName: `${stack}_${name}`,
        source,
        ...(s.command !== undefined ? { command: toCommand(s.command) } : {}),
        ...(s.port !== undefined ? { port: s.port } : {}),
        replicas,
        ...(sleepAfterSeconds !== undefined ? { sleepAfterSeconds } : {}),
        ...(cpu !== undefined ? { cpu } : {}),
        ...(memoryMb !== undefined ? { memoryMb } : {}),
        ...(healthcheck ? { healthcheck } : {}),
        env,
        bindings: [...bindings].sort(),
        secrets: [...(s.secrets ?? [])].sort(),
        volumes: Object.entries(s.volumes ?? {})
          .map(([v, target]) => ({ name: v, volumeName: `${stack}_${name}-${v}`, target }))
          .sort((a, b) => (a.name < b.name ? -1 : 1)),
        placement: {
          regions: [...(s.regions ?? [])].sort(),
          labels: { ...(s.placement?.labels ?? {}) },
        },
        dependsOn: [...dependsOn].sort(),
      };
      return withSig(unit);
    }),
  );

  // ── routes ──
  const routes: DesiredRoute[] = [];
  let firstPreviewHost = true;
  for (const [name, s] of Object.entries(cfg.services)) {
    if (s.port === undefined) continue;
    const port = s.port;
    const domains = s.domains ?? [];
    if (preview) {
      // One host per service: the first routed service gets pr-<N>.<base>.
      if (!domains.length) continue;
      const host = firstPreviewHost
        ? `pr-${preview.pr}.${preview.baseDomain}`
        : `pr-${preview.pr}-${name}.${preview.baseDomain}`;
      firstPreviewHost = false;
      const d = domains[0];
      const protection =
        d && typeof d !== 'string' && d.protect ? toProtection(d.protect) : undefined;
      routes.push(
        withSig({
          host,
          path: '/',
          service: name,
          port,
          stripPath: false,
          ...(protection ? { protection } : {}),
        }),
      );
      continue;
    }
    for (const d of domains) {
      const { host, path } = domainHost(d);
      const obj = typeof d === 'string' ? undefined : d;
      const protection = obj?.protect ? toProtection(obj.protect) : undefined;
      routes.push(
        withSig({
          host,
          path,
          service: name,
          port,
          stripPath: obj?.strip_path ?? false,
          ...(protection ? { protection } : {}),
        }),
      );
    }
  }
  routes.sort((a, b) => (a.host + a.path < b.host + b.path ? -1 : 1));

  // ── jobs (never in previews: a PR shouldn't run production cron) ──
  const jobs: DesiredJob[] = preview
    ? []
    : sortByName(
        Object.entries(cfg.jobs ?? {}).map(([name, j]) => {
          const service = j.image === undefined ? (j.service ?? defaultJobService(cfg)) : undefined;
          return withSig({
            name,
            schedule: j.schedule.trim(),
            ...(service ? { service } : {}),
            ...(j.image ? { image: j.image } : {}),
            command: toCommand(j.run) ?? [],
            timeoutSeconds:
              j.timeout !== undefined
                ? (parseDuration(j.timeout) ?? DEFAULT_JOB_TIMEOUT_SECONDS)
                : DEFAULT_JOB_TIMEOUT_SECONDS,
            retries: j.retries ?? 0,
            env: strEnv(j.env),
          });
        }),
      );

  return {
    app: cfg.app,
    stack,
    ...(preview ? { preview: { pr: preview.pr } } : {}),
    ...(shared ? { sharedResourcesFrom: cfg.app } : {}),
    services,
    resources,
    routes,
    jobs,
    connect: preview ? [] : [...new Set(cfg.connect ?? [])].sort(),
    previews: previewsCfg,
  };
}

function normPath(p: string): string {
  const s = p.replace(/^\.\/+/, '').replace(/\/+$/, '');
  return s === '' ? '.' : s;
}

function toProtection(
  p: NonNullable<
    Extract<NonNullable<AppConfig['services'][string]['domains']>[number], object>['protect']
  >,
): DesiredProtection {
  return {
    ...(p.rate_limit ? { rateLimit: parseRate(p.rate_limit) ?? undefined } : {}),
    ...(p.ip_allow ? { ipAllow: p.ip_allow } : {}),
    ...(p.ip_deny ? { ipDeny: p.ip_deny } : {}),
    ...(p.countries_allow ? { countryAllow: p.countries_allow } : {}),
    ...(p.countries_deny ? { countryDeny: p.countries_deny } : {}),
    ...(p.block_bots !== undefined ? { blockBots: p.block_bots } : {}),
    ...(p.body_max ? { bodyMaxSize: p.body_max } : {}),
    ...(p.waf !== undefined ? { waf: p.waf } : {}),
    ...(p.cache !== undefined ? { cacheTtlSeconds: parseDuration(p.cache) ?? undefined } : {}),
  };
}
