/**
 * A managed Postgres cluster's memory (board 39, "Version & size · Memory"):
 * one limit for every copy, and the two settings sized from it. PURE.
 *
 * Declared on the primary (written by `db.setMemory`):
 *   swarmy.db.memoryMb           the limit per copy, in MB; absent = no limit
 * Per member (the reconcile stamps it when it restarts that copy):
 *   swarmy.db.memoryMb.applied   the limit this member's spec was built with
 *
 * {@link applyPgMemory} derives the member's swarm memory limit and the boot
 * layer's env (`SWARMY_PG_SHARED_BUFFERS` / `_EFFECTIVE_CACHE_SIZE`, written
 * to a conf on every start) from the APPLIED label. It runs inside
 * `applyPgMember`, so every rebuild of a member — failover repoint, PITR,
 * extension restarts — keeps the memory it was last restarted with. The
 * rolling restart that moves each copy to the declared value is
 * `manageddb-memory-plan.ts`: standbys first, the writer last and in place.
 */
import { DB_EXTENSIONS_APPLIED_LABEL, DB_EXTENSIONS_LABEL } from './manageddb-extensions';
import { PG_ENV } from './manageddb-pg';
import { DB_POOLER_LABEL } from './manageddb-pooler';

export const DB_MEMORY_LABEL = 'swarmy.db.memoryMb';
export const DB_MEMORY_APPLIED_LABEL = 'swarmy.db.memoryMb.applied';
/** Smallest limit swarmy sets (Postgres plus its connections need room above shared_buffers). */
export const PG_MEMORY_MIN_MB = 256;
export const PG_MEMORY_MAX_MB = 256 * 1024;
/** The read the reconcile verifies a restarted copy with. */
export const PG_SHARED_BUFFERS_SQL = 'SHOW shared_buffers';

export interface PgMemorySettings {
  memoryMb: number;
  memoryBytes: number;
  /** 25% of the limit: Postgres's own page cache. */
  sharedBuffersMb: number;
  /** 75% of the limit: what the planner assumes the OS caches for it. */
  effectiveCacheSizeMb: number;
}

export function pgMemorySettings(memoryMb: number): PgMemorySettings {
  const mb = Math.floor(memoryMb);
  return {
    memoryMb: mb,
    memoryBytes: mb * 1024 * 1024,
    sharedBuffersMb: Math.floor(mb / 4),
    effectiveCacheSizeMb: Math.floor((mb * 3) / 4),
  };
}

export function isPgMemoryMb(n: number): boolean {
  return Number.isInteger(n) && n >= PG_MEMORY_MIN_MB && n <= PG_MEMORY_MAX_MB;
}

/** A label value → MB, or null (absent, or not a limit swarmy would set). */
export function parseMemoryMb(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return isPgMemoryMb(n) ? n : null;
}

/**
 * Cluster declarations that live on the primary and must follow the writer
 * when a standby is promoted (the ex-primary is relabelled a replica), or the
 * reconcile would read "no limit" / "no extensions" / "no pooler" and roll
 * every copy back (or remove the pooler it just repointed).
 */
export const PRIMARY_DECLARATION_LABELS = [DB_MEMORY_LABEL, DB_EXTENSIONS_LABEL, DB_EXTENSIONS_APPLIED_LABEL, DB_POOLER_LABEL] as const;

export function primaryDeclarations(labels: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PRIMARY_DECLARATION_LABELS) if (labels?.[k] !== undefined) out[k] = labels[k]!;
  return out;
}

/** The labels a fresh member gets so it starts at the cluster's declared memory. */
export function pgMemoryCarry(primaryLabels: Record<string, string> | undefined): Record<string, string> {
  const mb = parseMemoryMb(primaryLabels?.[DB_MEMORY_LABEL]);
  return mb === null ? {} : { [DB_MEMORY_APPLIED_LABEL]: String(mb) };
}

export interface MemorySpecLike {
  env?: Record<string, string>;
  resources?: {
    limits?: { cpus?: number; memoryBytes?: number };
    reservations?: { cpus?: number; memoryBytes?: number };
  };
}

/** The member's memory limit + boot-layer env, from its applied label (none ⇒ both cleared). */
export function applyPgMemory<S extends MemorySpecLike>(spec: S, labels: Record<string, string> | undefined): S {
  const env = { ...(spec.env ?? {}) };
  delete env[PG_ENV.sharedBuffers];
  delete env[PG_ENV.effectiveCacheSize];
  const mb = parseMemoryMb(labels?.[DB_MEMORY_APPLIED_LABEL]);
  if (mb === null) {
    const limits = { ...(spec.resources?.limits ?? {}) };
    delete limits.memoryBytes;
    const resources = { ...(spec.resources ?? {}), limits };
    return { ...spec, env, ...(spec.resources ? { resources } : {}) };
  }
  const m = pgMemorySettings(mb);
  env[PG_ENV.sharedBuffers] = `${m.sharedBuffersMb}MB`;
  env[PG_ENV.effectiveCacheSize] = `${m.effectiveCacheSizeMb}MB`;
  return {
    ...spec,
    env,
    resources: { ...(spec.resources ?? {}), limits: { ...(spec.resources?.limits ?? {}), memoryBytes: m.memoryBytes } },
  };
}

/** `SHOW shared_buffers` (`128MB`, `1GB`, `16384kB`, `2TB`) → MB; null when unreadable. */
export function parsePgSizeMb(raw: string): number | null {
  const m = /^\s*(\d+)\s*(kB|MB|GB|TB)\s*$/.exec(raw.trim().split(/\r?\n/)[0] ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { kB: 1 / 1024, MB: 1, GB: 1024, TB: 1024 * 1024 }[m[2] as 'kB' | 'MB' | 'GB' | 'TB'];
  return n * mult;
}
