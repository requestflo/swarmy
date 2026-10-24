/**
 * Flags + target resolution for the disaster-restore CLI (`restore.ts`).
 *
 * The backup target comes from the swarm when it holds one (the
 * `ctl-backup/controller` → `bkp-target/<id>` swarm-kv documents, read with
 * `readRestoreTargetFromKv`), and every flag (or its env alias) overrides
 * that field. With nothing in the swarm the flags are the whole target, as
 * before. Pure: the caller reads the swarm and passes the result in.
 */
import type { ResticRepo } from '@swarmy/core/protocol';
import type { KvRestoreTarget } from '@swarmy/trpc';

export interface Flags {
  [k: string]: string | boolean;
}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

type Env = Record<string, string | undefined>;

/** A flag's value, else its env alias, else the fallback. */
export function str(flags: Flags, key: string, env?: string, fallback?: string, envs: Env = process.env): string | undefined {
  const v = flags[key];
  if (typeof v === 'string') return v;
  if (env && envs[env]) return envs[env];
  return fallback;
}

/** [flag, env alias, field of the swarm's target]. */
const FIELDS = [
  ['target-kind', undefined, 'kind'],
  ['endpoint', undefined, 'endpoint'],
  ['bucket', undefined, 'bucket'],
  ['prefix', undefined, 'prefix'],
  ['region', 'AWS_DEFAULT_REGION', 'region'],
  ['access-key-id', 'AWS_ACCESS_KEY_ID', 'accessKeyId'],
  ['secret-access-key', 'AWS_SECRET_ACCESS_KEY', 'secretAccessKey'],
  ['restic-password', 'RESTIC_PASSWORD', 'resticPassword'],
] as const;

export interface ResolvedRepo {
  repo: ResticRepo;
  /** Fields a flag or env alias set over the swarm's target (names only, never values). */
  overridden: string[];
}

export function buildRepo(flags: Flags, kv: KvRestoreTarget | null = null, envs: Env = process.env): ResolvedRepo {
  const v: Record<string, string | undefined> = {};
  const overridden: string[] = [];
  for (const [flag, env, field] of FIELDS) {
    const own = str(flags, flag, env, undefined, envs);
    const fromKv = kv?.[field];
    if (own !== undefined && fromKv !== undefined && own !== fromKv) overridden.push(flag);
    v[field] = own ?? fromKv;
  }
  const kind = (v.kind ?? 's3') as 's3' | 'node';
  const { endpoint, bucket, prefix } = v;
  if (!bucket) throw new Error('--bucket is required (the restic repo bucket/path) — the swarm holds no controller-backup destination');
  const prefixSeg = prefix ? `/${prefix.replace(/^\/+/, '')}` : '';
  const repoUrl =
    kind === 'node'
      ? `${bucket.replace(/\/+$/, '')}${prefixSeg}`
      : `s3:${(endpoint ?? '').replace(/\/+$/, '')}/${bucket}${prefixSeg}`;
  if (!v.resticPassword) throw new Error('--restic-password (or RESTIC_PASSWORD) is required');
  return {
    repo: {
      kind,
      repo: repoUrl,
      password: v.resticPassword,
      endpoint,
      region: v.region,
      accessKeyId: v.accessKeyId,
      secretAccessKey: v.secretAccessKey,
    },
    overridden,
  };
}
