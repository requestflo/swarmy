/**
 * Ticked detections → a swarmy.yaml v1 the app can commit. Every connection
 * is a binding (`${{ db.url }}`) that swarmy fills in at deploy, so the file
 * holds no hosts, passwords or keys. The text always goes back through
 * `parseAppConfig` before anyone sees "valid".
 */
import { Document, isScalar } from 'yaml';
import { DEFAULT_POSTGRES_VERSION, type AppConfigInput } from '../schema';
import type { Detection } from './types';

export interface BuildOptions {
  /** Build context (default: the app's folder). */
  path?: string;
  /** Dockerfile, relative to `path`. */
  dockerfile?: string;
  target?: string;
  args?: Record<string, string>;
  /** Paths whose change rebuilds (default: `path`). */
  watch?: string[];
}

export interface GenerateOptions {
  app: string;
  dir?: string;
  /** Ticked detection ids (default: every one). The web service is always in. */
  selected?: readonly string[];
  build?: BuildOptions;
}

export interface GeneratedConfig {
  yaml: string;
  config: AppConfigInput;
  /** Detections that were ticked but couldn't be written, in plain words. */
  notes: string[];
}

/** A valid `app:` name from a folder or repo name (`services/Orders` → `orders`). */
export function suggestAppName(raw: string): string {
  const base = raw.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() ?? '';
  const n = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 40).replace(/-+$/, '');
  return n || 'app';
}

function bucketField(name: string): string | null {
  if (/BUCKET/.test(name)) return 'bucket';
  if (/ENDPOINT/.test(name)) return 'endpoint';
  if (/REGION/.test(name)) return 'region';
  return null;
}

const cacheField = (name: string): string => (/_HOST$/.test(name) ? 'host' : /_PORT$/.test(name) ? 'port' : 'url');

export function generateAppConfig(detections: Detection[], opts: GenerateOptions): GeneratedConfig {
  const pick = opts.selected ? new Set(opts.selected) : null;
  const on = detections.filter((d) => d.required || !pick || pick.has(d.id));
  const of = (kind: Detection['kind']) => on.filter((d) => d.kind === kind);
  const notes: string[] = [];
  const dir = (opts.dir ?? '').replace(/^\.?\/*|\/+$/g, '');
  const b = opts.build ?? {};
  const path = b.path?.trim() || dir || '.';
  const extra = {
    ...(b.dockerfile?.trim() ? { dockerfile: b.dockerfile.trim() } : {}),
    ...(b.target?.trim() ? { target: b.target.trim() } : {}),
    ...(b.args && Object.keys(b.args).length ? { args: b.args } : {}),
    ...(b.watch?.length ? { watch: b.watch } : {}),
  };
  const build = Object.keys(extra).length ? { path, ...extra } : path;

  const web = on.find((d) => d.kind === 'web');
  const db = of('postgres')[0];
  const services: Record<string, Record<string, unknown>> = {
    web: {
      build,
      ...(web?.port ? { port: web.port } : {}),
      ...(web?.port && web.healthPath ? { healthcheck: { path: web.healthPath } } : {}),
      ...(db?.release ? { release: db.release } : {}),
    },
  };
  for (const w of of('worker')) services[w.name] = { build, command: w.command };
  const workerHost = of('worker')[0]?.name;
  const jobs: Record<string, Record<string, unknown>> = {};
  let pinned: { host: string; why: string } | null = null;
  for (const c of of('cron')) {
    if (c.via === 'clock') services[c.name] = { build, command: c.command, replicas: 1 };
    else if (c.via === 'script' && c.schedule && c.command) {
      jobs[c.name] = { schedule: c.schedule, service: workerHost ?? 'web', run: c.command };
    } else if (c.via === 'http' && c.schedule && c.path) {
      if (!web?.port) {
        notes.push(`${c.path} runs on a schedule, but the web service has no port to call — add a port, then jobs.${c.name}.`);
        continue;
      }
      const url = `http://localhost:${web.port}${c.path}`;
      jobs[c.name] = {
        schedule: c.schedule,
        service: 'web',
        run: `node -e "fetch('${url}', { headers: { authorization: 'Bearer ' + (process.env.CRON_SECRET || '') } }).then((r) => process.exit(r.ok ? 0 : 1))"`,
      };
    } else if (c.via === 'in-process') {
      const host = c.host && services[c.host] ? c.host : 'web';
      services[host] = { ...services[host], replicas: 1 };
      pinned = { host, why: ` ${c.label.replace(/^In-app schedule \((.*)\)$/, '$1')} runs in-process: more copies fire each schedule more than once` };
    }
  }

  const env: Record<string, string> = {};
  for (const v of db?.env ?? []) env[v] = `\${{ ${db!.name}.url }}`;
  for (const c of [...of('cache'), ...of('queue')]) for (const v of c.env ?? []) env[v] = `\${{ ${c.name}.${cacheField(v)} }}`;
  const resources: Record<string, Record<string, unknown>> = {};
  if (db) resources[db.name] = { type: 'postgres', version: DEFAULT_POSTGRES_VERSION };
  for (const c of of('cache')) resources[c.name] = { type: 'cache', engine: 'valkey' };
  for (const q of of('queue')) resources[q.name] = { type: 'queue' };
  for (const s of of('bucket')) {
    resources[s.name] = { type: 'bucket', access: 'internal' };
    for (const v of s.env ?? []) {
      const field = bucketField(v);
      if (field) env[v] = `\${{ ${s.name}.${field} }}`;
    }
    env.S3_ACCESS_KEY_ID = `\${{ ${s.name}.access_key_id }}`;
    env.S3_SECRET_ACCESS_KEY_FILE = `\${{ ${s.name}.secret_access_key_file }}`;
  }

  const config: AppConfigInput = {
    version: 1,
    app: suggestAppName(opts.app),
    ...(Object.keys(env).length ? { env } : {}),
    services: services as AppConfigInput['services'],
    ...(Object.keys(resources).length ? { resources: resources as AppConfigInput['resources'] } : {}),
    ...(Object.keys(jobs).length ? { jobs: jobs as AppConfigInput['jobs'] } : {}),
  };
  const doc = new Document(config);
  doc.commentBefore = ` Generated by swarmy from ${dir || 'the repo root'} — review it, then commit it.\n Connections are filled in at deploy: no hosts, passwords or keys live in git.`;
  if (pinned) {
    const node = doc.getIn(['services', pinned.host, 'replicas'], true);
    if (isScalar(node)) node.comment = pinned.why;
  }
  return { yaml: doc.toString({ lineWidth: 0 }), config, notes };
}
