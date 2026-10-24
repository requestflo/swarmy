/**
 * The disaster-restore CLI's read of the swarm: where controller backups go,
 * from the swarm-kv documents every manager's raft holds (P4 slice 3). It
 * needs this host's Docker socket on a swarm manager and SWARMY_SECRET_KEY
 * (state.env) to open the documents. Anything missing falls back to the
 * flags, with one log line saying why; `--no-swarm-kv` skips the read.
 */
import type { KvDriver } from '@swarmy/core';
import { localDockerKvDriver } from '@swarmy/core/swarm-kv-docker';
import { readRestoreTargetFromKv, type KvRestoreTarget } from '@swarmy/trpc';
import { str, type Flags } from './restore-args';

export interface SwarmReadDeps {
  driver?: () => KvDriver;
  env?: Record<string, string | undefined>;
}

function where(t: KvRestoreTarget): string {
  const base = t.kind === 'node' ? t.bucket : `${t.endpoint ?? ''}/${t.bucket}`;
  return t.prefix ? `${base}/${t.prefix.replace(/^\/+/, '')}` : base;
}

export async function targetFromSwarm(
  flags: Flags,
  log: (m: string) => void,
  deps: SwarmReadDeps = {},
): Promise<KvRestoreTarget | null> {
  const env = deps.env ?? process.env;
  const named = str(flags, 'target', undefined, undefined, env);
  if (flags['no-swarm-kv']) {
    log('not reading the swarm (--no-swarm-kv): the flags are the target');
    return null;
  }
  if (!env.SWARMY_SECRET_KEY) {
    if (named) throw new Error('--target needs SWARMY_SECRET_KEY (source state.env) to read the swarm’s config');
    log('SWARMY_SECRET_KEY is not set, so the swarm’s config can’t be opened: the flags are the target (source state.env to read it from the swarm)');
    return null;
  }
  try {
    const t = await readRestoreTargetFromKv((deps.driver ?? localDockerKvDriver)(), { target: named });
    if (t) log(`backup destination from the swarm: "${t.name}" (${where(t)})`);
    else log('the swarm holds no controller-backup destination: the flags are the target');
    return t;
  } catch (e) {
    if (named) throw e; // a destination was asked for by name: never guess another
    log(`couldn't read the swarm’s config (${e instanceof Error ? e.message : String(e)}): the flags are the target`);
    return null;
  }
}
