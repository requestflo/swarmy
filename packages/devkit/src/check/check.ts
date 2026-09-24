/**
 * `swarmy check` — "will this work on swarmy?", answered locally.
 *
 * Reads the repo (never writes, never calls the controller): finds how swarmy
 * would deploy it (swarmy.yaml → compose → Dockerfile → a detected stack),
 * validates swarmy.yaml with the same `@swarmy/app-config` parser the
 * controller runs on push (identical errors, identical line numbers), and says
 * in plain words what a deploy would create plus anything that will break.
 */
import {
  CONFIG_FILENAMES,
  parseAppConfig,
  toDesired,
  type AppConfig,
  type DesiredApp,
  type DesiredResource,
} from '@swarmy/app-config';
import { parse as parseYaml } from 'yaml';
import { detectStack, describeDetection, type StackDetection } from './detect';
import { cleanRel, joinRel, type RepoFs } from './fs';

export type CheckSeverity = 'error' | 'warning' | 'info';

export interface CheckIssue {
  severity: CheckSeverity;
  /** Stable machine code (`config/…` codes come straight from app-config). */
  code: string;
  message: string;
  file?: string;
  line?: number;
  col?: number;
  /** Dotted path into swarmy.yaml, when the issue is about a key. */
  path?: string;
}

export type CheckMode = 'swarmy.yaml' | 'compose' | 'dockerfile' | 'detected' | 'unknown';

export interface CheckService {
  name: string;
  /** How its image is made. */
  source: 'dockerfile' | 'railpack' | 'image' | 'compose';
  /** Build context (repo-relative) or the image reference. */
  from: string;
  dockerfile?: string;
  detected?: StackDetection;
  port?: number;
  replicas?: number;
  domains: string[];
}

export interface CheckReport {
  /** No errors (warnings allowed). */
  ok: boolean;
  mode: CheckMode;
  configPath: string | null;
  app: string | null;
  /** The stack a production deploy would create/update. */
  stack: string | null;
  services: CheckService[];
  resources: Array<{ name: string; type: string; detail: string }>;
  routes: Array<{ host: string; path: string; service: string; port: number }>;
  jobs: Array<{ name: string; schedule: string }>;
  /** Plain-words summary of what swarmy will do, in order. */
  plan: string[];
  issues: CheckIssue[];
  /** A starter swarmy.yaml when the repo has none (always parses clean). */
  suggestedConfig?: string;
}

export interface CheckOptions {
  /** Repo-relative swarmy.yaml path (default: swarmy.yaml / swarmy.yml at the root). */
  configPath?: string;
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** `docker stack deploy` ignores these compose keys (Swarm has no equivalent). */
const SWARM_IGNORED_KEYS: Record<string, string> = {
  container_name: 'Swarm names containers itself',
  links: 'use the stack network (service names resolve) instead',
  external_links: 'use a shared network instead',
  network_mode: 'Swarm services use overlay networks',
  restart: 'use deploy.restart_policy',
  devices: 'not supported by Swarm services',
  cgroup_parent: 'not supported by Swarm services',
  security_opt: 'not supported by Swarm services',
  userns_mode: 'not supported by Swarm services',
  tmpfs: 'use a tmpfs mount under volumes instead',
};

export const RAILPACK_NOTE =
  'swarmy builds it with Railpack (zero-config) when the controller has zero-config builds; add a Dockerfile to pin the build yourself';

function describeResource(r: DesiredResource): string {
  switch (r.type) {
    case 'postgres':
      return `Postgres ${r.version}${r.ha === 'single' ? '' : ` (${r.ha}, ${r.replicas} replica${r.replicas === 1 ? '' : 's'})`}${r.backups ? `, ${r.backups.schedule} backups kept ${r.backups.keep}` : ', no backups'}`;
    case 'cache':
      return `${r.engine} cache, ${r.memoryMb} MB${r.ha === 'single' ? '' : ` (${r.ha})`}`;
    case 'search':
      return `${r.engine} search`;
    case 'vector':
      return r.engine === 'pgvector' ? `pgvector on ${r.on ?? 'its own Postgres'}` : 'Qdrant vector store';
    case 'bucket':
      return `object storage bucket (${r.access}${r.quotaMb ? `, ${r.quotaMb} MB quota` : ''})`;
  }
}

function explicitDockerfile(cfg: AppConfig, service: string): string | undefined {
  const b = cfg.services[service]?.build;
  return b && typeof b === 'object' && 'dockerfile' in b && b.dockerfile ? b.dockerfile : undefined;
}

async function findConfig(fs: RepoFs, opts: CheckOptions): Promise<string | null> {
  if (opts.configPath) {
    const p = cleanRel(opts.configPath);
    return p && (await fs.exists(p)) ? p : null;
  }
  for (const f of CONFIG_FILENAMES) if (await fs.exists(f)) return f;
  return null;
}

async function checkSwarmyYaml(fs: RepoFs, configPath: string, report: CheckReport): Promise<void> {
  report.mode = 'swarmy.yaml';
  report.configPath = configPath;
  const text = (await fs.read(configPath)) ?? '';
  const parsed = parseAppConfig(text);
  for (const i of parsed.issues) {
    report.issues.push({
      severity: i.severity,
      code: i.code,
      message: i.message,
      file: configPath,
      ...(i.line !== undefined ? { line: i.line } : {}),
      ...(i.col !== undefined ? { col: i.col } : {}),
      ...(i.path.length ? { path: i.path.join('.') } : {}),
    });
  }
  const cfg = parsed.config;
  if (!cfg) {
    report.plan.push(`Fix ${configPath} first — swarmy refuses to deploy a config with errors.`);
    return;
  }
  let desired: DesiredApp;
  try {
    desired = toDesired(cfg);
  } catch (e) {
    report.issues.push({
      severity: 'error',
      code: 'config/unplannable',
      message: e instanceof Error ? e.message : String(e),
      file: configPath,
    });
    return;
  }
  report.app = desired.app;
  report.stack = desired.stack;

  for (const r of desired.resources) {
    report.resources.push({ name: r.name, type: r.type, detail: describeResource(r) });
  }

  for (const s of desired.services) {
    const domains = desired.routes.filter((r) => r.service === s.name).map((r) => `${r.host}${r.path === '/' ? '' : r.path}`);
    const base = {
      name: s.name,
      domains,
      replicas: s.replicas,
      ...(s.port !== undefined ? { port: s.port } : {}),
    };
    if (s.source.kind === 'image') {
      report.services.push({ ...base, source: 'image', from: s.source.image });
      const img = s.source.image;
      const tag = img.includes('@') ? 'digest' : (img.split('/').pop() ?? '').includes(':') ? img.split(':').pop() : undefined;
      if (!tag || tag === 'latest') {
        report.issues.push({
          severity: 'warning',
          code: 'image/unpinned',
          message: `services.${s.name}: image "${img}" is not pinned to a tag — every deploy may pull something different`,
          file: configPath,
          path: `services.${s.name}.image`,
        });
      }
      continue;
    }
    const ctx = s.source.context === '.' ? '' : s.source.context;
    const ctxLabel = ctx || '.';
    if (ctx && !(await fs.exists(ctx))) {
      report.issues.push({
        severity: 'error',
        code: 'build/missing-context',
        message: `services.${s.name}: build path "${ctxLabel}" does not exist in the repo`,
        file: configPath,
        path: `services.${s.name}.build`,
      });
      report.services.push({ ...base, source: 'dockerfile', from: ctxLabel });
      continue;
    }
    const pinned = explicitDockerfile(cfg, s.name);
    const dockerfile = joinRel(ctx, s.source.dockerfile);
    if (await fs.exists(dockerfile)) {
      report.services.push({ ...base, source: 'dockerfile', from: ctxLabel, dockerfile });
      continue;
    }
    if (pinned) {
      report.issues.push({
        severity: 'error',
        code: 'build/missing-dockerfile',
        message: `services.${s.name}: dockerfile "${dockerfile}" does not exist`,
        file: configPath,
        path: `services.${s.name}.build.dockerfile`,
      });
      report.services.push({ ...base, source: 'dockerfile', from: ctxLabel, dockerfile });
      continue;
    }
    const detected = await detectStack(fs, ctx);
    if (!detected) {
      report.issues.push({
        severity: 'error',
        code: 'build/undetectable',
        message: `services.${s.name}: no Dockerfile in "${ctxLabel}" and no recognisable stack (package.json, pyproject.toml, go.mod, …) — add a Dockerfile or use image:`,
        file: configPath,
        path: `services.${s.name}.build`,
      });
      report.services.push({ ...base, source: 'railpack', from: ctxLabel });
      continue;
    }
    report.services.push({ ...base, source: 'railpack', from: ctxLabel, detected });
    report.issues.push({
      severity: 'warning',
      code: 'build/railpack',
      message: `services.${s.name}: no Dockerfile in "${ctxLabel}" (detected ${describeDetection(detected)}); ${RAILPACK_NOTE}`,
      file: configPath,
      path: `services.${s.name}.build`,
    });
    for (const w of detected.warnings) {
      report.issues.push({ severity: 'warning', code: 'build/stack', message: `services.${s.name}: ${w}`, file: joinRel(ctx, detected.evidence[0] ?? '') });
    }
    if (detected.port && s.port && detected.port !== s.port && detected.port !== 80) {
      report.issues.push({
        severity: 'info',
        code: 'build/port',
        message: `services.${s.name}: ${detected.framework ?? detected.language} usually listens on ${detected.port}, swarmy.yaml says ${s.port} — make sure the app binds to $PORT or ${s.port}`,
        file: configPath,
        path: `services.${s.name}.port`,
      });
    }
  }

  for (const r of desired.routes) report.routes.push({ host: r.host, path: r.path, service: r.service, port: r.port });
  for (const j of desired.jobs) report.jobs.push({ name: j.name, schedule: j.schedule });

  // ── the plan, in apply order ──
  report.plan.push(`Deploy app "${desired.app}" as stack "${desired.stack}" (production).`);
  for (const r of report.resources) report.plan.push(`Create ${r.name}: ${r.detail}.`);
  for (const s of report.services) {
    const how =
      s.source === 'image'
        ? `pull ${s.from}`
        : s.source === 'dockerfile'
          ? `build ${s.dockerfile ?? `${s.from}/Dockerfile`}`
          : `build ${s.from} with Railpack${s.detected ? ` (${describeDetection(s.detected)})` : ''}`;
    const release = desired.services.find((d) => d.name === s.name)?.release;
    report.plan.push(
      `Service ${s.name}: ${how}, ${s.replicas ?? 1} replica${s.replicas === 1 ? '' : 's'}${s.port ? `, port ${s.port}` : ''}${release ? `, run "${release.join(' ')}" before each release` : ''}.`,
    );
  }
  for (const r of report.routes) {
    report.plan.push(`Route https://${r.host}${r.path === '/' ? '' : r.path} → ${r.service}:${r.port} (TLS certificate issued automatically).`);
  }
  for (const j of report.jobs) report.plan.push(`Schedule job ${j.name} at "${j.schedule}".`);
  if (desired.previews.enabled) {
    report.plan.push(
      `Open a preview environment for every pull request (${desired.previews.resources} resources, torn down after ${Math.round(desired.previews.ttlSeconds / 3600)}h).`,
    );
  }
  for (const env of Object.keys(cfg.environments ?? {})) {
    report.plan.push(`Environment "${env}" deploys to its own stack "${desired.app}-${env}".`);
  }
}

async function checkCompose(fs: RepoFs, file: string, report: CheckReport): Promise<void> {
  report.mode = 'compose';
  report.configPath = file;
  let doc: unknown;
  try {
    doc = parseYaml((await fs.read(file)) ?? '');
  } catch (e) {
    report.issues.push({
      severity: 'error',
      code: 'compose/yaml',
      message: `${file} is not valid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      file,
    });
    return;
  }
  const services = (doc && typeof doc === 'object' ? (doc as { services?: unknown }).services : undefined) as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!services || typeof services !== 'object' || !Object.keys(services).length) {
    report.issues.push({ severity: 'error', code: 'compose/no-services', message: `${file} defines no services`, file });
    return;
  }
  for (const [name, svc] of Object.entries(services)) {
    const s = svc ?? {};
    const image = typeof s.image === 'string' ? s.image : undefined;
    const ports = Array.isArray(s.ports) ? s.ports : [];
    const firstPort = ports.length ? Number(String(ports[0]).split(':').pop()?.split('/')[0]) : NaN;
    report.services.push({
      name,
      source: 'compose',
      from: image ?? (s.build ? 'build:' : '(no image)'),
      domains: [],
      ...(Number.isFinite(firstPort) ? { port: firstPort } : {}),
    });
    if (!image && s.build) {
      report.issues.push({
        severity: 'error',
        code: 'compose/build-only',
        message: `services.${name} has build: but no image: — docker stack deploy never builds. Push an image (or move to swarmy.yaml, where swarmy builds for you)`,
        file,
        path: `services.${name}`,
      });
    } else if (!image) {
      report.issues.push({ severity: 'error', code: 'compose/no-image', message: `services.${name} has no image`, file, path: `services.${name}` });
    }
    for (const [key, why] of Object.entries(SWARM_IGNORED_KEYS)) {
      if (key in s) {
        report.issues.push({
          severity: 'warning',
          code: 'compose/ignored-key',
          message: `services.${name}.${key} is ignored on Swarm — ${why}`,
          file,
          path: `services.${name}.${key}`,
        });
      }
    }
    const dependsOn = s.depends_on;
    if (dependsOn && typeof dependsOn === 'object' && !Array.isArray(dependsOn)) {
      report.issues.push({
        severity: 'info',
        code: 'compose/depends-on',
        message: `services.${name}.depends_on conditions are not enforced on Swarm — make the service retry until its dependencies answer`,
        file,
        path: `services.${name}.depends_on`,
      });
    }
  }
  report.plan.push(`Deploy ${file} as a Swarm stack (${report.services.length} service${report.services.length === 1 ? '' : 's'}).`);
  report.plan.push('Add a swarmy.yaml to get builds, managed databases, domains and previews from one file.');
}

/** A starter swarmy.yaml for a repo swarmy can already build. Parses clean by construction. */
export function starterConfig(appName: string, detected: StackDetection | null, hasDockerfile: boolean): string {
  const port = detected?.port && detected.port !== 80 ? detected.port : hasDockerfile ? 8080 : (detected?.port ?? 8080);
  return [
    '# yaml-language-server: $schema=https://swarmy.dev/schema/swarmy.v1.json',
    'version: 1',
    `app: ${appName}`,
    'services:',
    '  web:',
    '    build: .',
    `    port: ${port}`,
    '    healthcheck: { path: / }',
    '',
  ].join('\n');
}

/** Lower-kebab app name from a directory or package name (`My_App` → `my-app`). */
export function appNameFrom(raw: string | undefined): string {
  const n = (raw ?? '')
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return n || 'app';
}

/** Run every check against a repo. */
export async function checkRepo(fs: RepoFs, opts: CheckOptions & { name?: string } = {}): Promise<CheckReport> {
  const report: CheckReport = {
    ok: true,
    mode: 'unknown',
    configPath: null,
    app: null,
    stack: null,
    services: [],
    resources: [],
    routes: [],
    jobs: [],
    plan: [],
    issues: [],
  };

  const configPath = await findConfig(fs, opts);
  if (opts.configPath && !configPath) {
    report.issues.push({ severity: 'error', code: 'config/not-found', message: `${opts.configPath} does not exist` });
  } else if (configPath) {
    await checkSwarmyYaml(fs, configPath, report);
  } else {
    const compose = (await Promise.all(COMPOSE_FILES.map(async (f) => ((await fs.exists(f)) ? f : null)))).find(Boolean);
    if (compose) {
      await checkCompose(fs, compose, report);
    } else {
      const hasDockerfile = await fs.exists('Dockerfile');
      const detected = hasDockerfile ? null : await detectStack(fs, '');
      let pkgName: string | undefined;
      try {
        pkgName = (JSON.parse((await fs.read('package.json')) ?? '{}') as { name?: string }).name;
      } catch {
        pkgName = undefined;
      }
      const app = appNameFrom(pkgName ?? opts.name);
      if (hasDockerfile || detected) {
        report.mode = hasDockerfile ? 'dockerfile' : 'detected';
        report.app = app;
        report.stack = app;
        report.services.push({
          name: 'web',
          source: hasDockerfile ? 'dockerfile' : 'railpack',
          from: '.',
          ...(hasDockerfile ? { dockerfile: 'Dockerfile' } : {}),
          ...(detected ? { detected } : {}),
          ...(detected?.port ? { port: detected.port } : {}),
          domains: [],
        });
        report.suggestedConfig = starterConfig(app, detected, hasDockerfile);
        report.issues.push({
          severity: 'info',
          code: 'config/missing',
          message: 'no swarmy.yaml — swarmy can deploy this as one service; commit the suggested swarmy.yaml to control ports, domains and databases',
        });
        report.plan.push(
          hasDockerfile
            ? 'Build the root Dockerfile and run it as one service.'
            : `Build the repo with Railpack (${describeDetection(detected!)}) and run it as one service.`,
        );
        if (detected) {
          report.issues.push({ severity: 'warning', code: 'build/railpack', message: `no Dockerfile; ${RAILPACK_NOTE}` });
          for (const w of detected.warnings) report.issues.push({ severity: 'warning', code: 'build/stack', message: w });
        }
      } else {
        report.issues.push({
          severity: 'error',
          code: 'repo/undetectable',
          message:
            'swarmy cannot tell how to build this repo: no swarmy.yaml, compose file, Dockerfile, or recognisable stack (package.json, pyproject.toml, go.mod, Gemfile, …)',
        });
      }
    }
  }

  report.ok = !report.issues.some((i) => i.severity === 'error');
  return report;
}
