/**
 * Controller-store configuration: where control.db is replicated to, and
 * where the boot fallback finds the latest controller bundle.
 *
 * Both must be known BEFORE the database opens, because a controller that lands
 * on an empty volume has nothing else to read. So they come from a Docker
 * secret mounted at /run/secrets/control_store, not from the DB. The secret
 * holds `swarmy_control_store.<n>`, a JSON document written by the controller
 * (`controllerStore.enableReplication`). The installer creates an empty one
 * (`{}`), and Docker keeps it encrypted in raft. Changing it means creating
 * a new secret and updating the service, which restarts the controller once.
 *
 * Identity comes from Swarm service templates set in the stack file
 * (`{{.Task.ID}}`, `{{.Node.ID}}`, `{{.Node.Hostname}}`, `{{.Service.Name}}`).
 */
import { readFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import type { ResticRepo } from '@swarmy/core/protocol';
import { resolveDbPaths } from '@swarmy/db';

export const DEFAULT_STORE_FILE = '/run/secrets/control_store';

export interface ReplicaTarget {
  /** 'garage' = swarmy's own store (bucket swarmy-control); 'backup-target' = an S3 BackupTarget. */
  kind: 'garage' | 'backup-target';
  /** Human label for the dashboard ("Garage (in-swarm)", a target's name). */
  label: string;
  /** BackupTarget id when kind = backup-target. */
  targetId?: string;
  endpoint: string;
  bucket: string;
  /** Key prefix inside the bucket. Litestream writes under `<prefix>/db`. */
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  skipVerify?: boolean;
}

export interface BundleSource {
  label?: string;
  /** The restic repo (ResticRepo wire shape). */
  repo: ResticRepo;
  /** The bundle restore passphrase. */
  passphrase: string;
}

export interface ControlStoreConfig {
  version: 1;
  replica?: ReplicaTarget;
  bundle?: BundleSource;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Validate the secret's JSON (hand-rolled: apps/api carries no schema lib). */
export function parseControlStoreConfig(raw: unknown): ControlStoreConfig {
  const problems: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: ControlStoreConfig = { version: 1 };
  if (o.replica != null) {
    const r = o.replica as Record<string, unknown>;
    for (const k of ['label', 'endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']) if (!str(r[k])) problems.push(`replica.${k} is required`);
    if (r.kind !== 'garage' && r.kind !== 'backup-target') problems.push('replica.kind must be garage or backup-target');
    if (!problems.length) {
      out.replica = {
        kind: r.kind as ReplicaTarget['kind'],
        label: r.label as string,
        ...(str(r.targetId) ? { targetId: r.targetId } : {}),
        endpoint: r.endpoint as string,
        bucket: r.bucket as string,
        prefix: str(r.prefix) ? r.prefix : 'control',
        region: str(r.region) ? r.region : 'us-east-1',
        accessKeyId: r.accessKeyId as string,
        secretAccessKey: r.secretAccessKey as string,
        ...(r.skipVerify === true ? { skipVerify: true } : {}),
      };
    }
  }
  if (o.bundle != null) {
    const b = o.bundle as Record<string, unknown>;
    const repo = (b.repo ?? {}) as Record<string, unknown>;
    if (!str(b.passphrase) || (b.passphrase as string).length < 8) problems.push('bundle.passphrase is required');
    if (repo.kind !== 's3' && repo.kind !== 'node') problems.push('bundle.repo.kind must be s3 or node');
    if (!str(repo.repo) || !str(repo.password)) problems.push('bundle.repo.repo and .password are required');
    if (!problems.length) {
      out.bundle = { ...(str(b.label) ? { label: b.label } : {}), repo: repo as unknown as ResticRepo, passphrase: b.passphrase as string };
    }
  }
  if (problems.length) throw new Error(problems.join('; '));
  return out;
}

/** Read the mounted secret. Missing, blank or `{}` means no replica and no bundle. */
export function loadControlStoreConfig(env: NodeJS.ProcessEnv = process.env): ControlStoreConfig {
  const file = env.SWARMY_CONTROL_STORE_FILE || DEFAULT_STORE_FILE;
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch {
    return { version: 1 };
  }
  if (!raw) return { version: 1 };
  try {
    return parseControlStoreConfig(JSON.parse(raw));
  } catch (e) {
    throw new Error(`controller store config (${file}) is invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface ControllerIdentity {
  taskId: string;
  nodeId: string;
  hostname: string;
  service: string;
}

export function controllerIdentity(env: NodeJS.ProcessEnv = process.env): ControllerIdentity {
  const host = env.SWARMY_NODE_HOSTNAME?.trim() || osHostname();
  return {
    // Outside Swarm (dev), make one up per process so leases still work.
    taskId: env.SWARMY_TASK_ID?.trim() || `local-${host}-${process.pid}`,
    nodeId: env.SWARMY_NODE_ID?.trim() || `local-${host}`,
    hostname: host,
    service: env.SWARMY_SERVICE_NAME?.trim() || 'swarmy_controller',
  };
}

/** Paths the store owns, all derived from control.db's path. */
export function storePaths(env: NodeJS.ProcessEnv = process.env) {
  const db = resolveDbPaths(env).control;
  const dir = db.slice(0, db.lastIndexOf('/')) || '.';
  const base = db.slice(db.lastIndexOf('/') + 1);
  return {
    db,
    dir,
    /** Local writer marker (see restore-select.ts). */
    marker: `${dir}/.${base}-swarmy.json`,
    /** Litestream's local meta dir. */
    litestreamMeta: `${dir}/.${base}-litestream`,
    /** What boot decided, for the dashboard. */
    bootReport: `${dir}/.${base}-boot.json`,
    litestreamConfig: env.SWARMY_LITESTREAM_CONFIG || '/tmp/swarmy-litestream.yml',
    litestreamSocket: env.SWARMY_LITESTREAM_SOCKET || '/tmp/swarmy-litestream.sock',
  };
}
export type StorePaths = ReturnType<typeof storePaths>;

/** Litestream binary (on $PATH in the controller image). */
export function litestreamBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SWARMY_LITESTREAM_BIN || 'litestream';
}
