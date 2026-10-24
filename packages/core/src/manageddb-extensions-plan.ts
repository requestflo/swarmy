/**
 * PURE — the one next step that brings a managed Postgres cluster's extensions
 * to what its primary's `swarmy.db.extensions` label asks for. The manageddb
 * reconcile runs one step per tick; at steady state the answer is `steady` and
 * nothing is sent.
 *
 * Order (the failover rules: the writer is never the first thing touched):
 *   1. drop    — an extension no longer wanted is dropped on the primary while
 *                its library is still loaded.
 *   2. restart standbys — every standby whose spec carries a different
 *                `SWARMY_PG_PRELOAD` is redeployed (the boot layer writes
 *                `shared_preload_libraries` on start).
 *   3. verify standbys — each is back, running, and `SHOW
 *                shared_preload_libraries` says so; only then
 *   4. restart writers — the primary (and active-active's extra writers)
 *                restart IN PLACE on their own data: no promotion, so no
 *                data-loss window; a few seconds without writes. A writer on
 *                temporary (anonymous) storage is never restarted.
 *   5. verify writers, then create — CREATE EXTENSION on the primary.
 */
import {
  PG_EXTENSION_CATALOG,
  encodeExtList,
  envPreload,
  parseExtError,
  parseExtList,
  preloadOf,
  DB_EXTENSIONS_APPLIED_LABEL,
  DB_EXTENSIONS_ERROR_LABEL,
  DB_EXTENSIONS_LABEL,
  type PgExtensionName,
} from './manageddb-extensions';

/** The structural subset of a live service the planner reads. */
export interface ExtServiceLike {
  name: string;
  labels: Record<string, string>;
  env?: readonly string[];
  desiredReplicas?: number;
  runningReplicas: number;
  updateStatus?: string;
}

export type ExtPhase = 'standby' | 'writer';

export interface ExtMember {
  service: string;
  phase: ExtPhase;
  /** `SWARMY_PG_PRELOAD` on the spec. */
  specPreload: string;
  desired: number;
  running: number;
  updating: boolean;
  /** Answered `SHOW shared_preload_libraries` with its spec's preload since its last restart. */
  verified: boolean;
}

export interface ExtPlanInput {
  wanted: PgExtensionName[];
  applied: PgExtensionName[];
  /** The wanted set a failed CREATE was stamped for. */
  failedFor: string | null;
  primaryRunning: boolean;
  /** False for a writer on temporary storage: restarting it would start an EMPTY database. */
  writersRedeployable: boolean;
  members: ExtMember[];
}

export type ExtStep =
  | { kind: 'steady' }
  | { kind: 'drop'; names: PgExtensionName[] }
  | { kind: 'restart' | 'verify'; phase: ExtPhase; services: string[]; preload: string }
  | { kind: 'create'; names: PgExtensionName[] }
  | { kind: 'blocked'; reason: string };

const isBack = (m: ExtMember) => m.desired === 0 || (m.running >= m.desired && !m.updating && m.verified);

export function planPgExtensions(i: ExtPlanInput): ExtStep {
  const preload = preloadOf(i.wanted);
  const toDrop = i.applied.filter((n) => !i.wanted.includes(n));
  if (toDrop.length > 0) {
    return i.primaryRunning ? { kind: 'drop', names: toDrop } : { kind: 'blocked', reason: 'the main copy is not running' };
  }
  const standbys = i.members.filter((m) => m.phase === 'standby');
  const writers = i.members.filter((m) => m.phase === 'writer');
  const stale = (ms: ExtMember[]) => ms.filter((m) => m.specPreload !== preload).map((m) => m.service);
  const waiting = (ms: ExtMember[]) => ms.filter((m) => !isBack(m)).map((m) => m.service);

  const staleStandbys = stale(standbys);
  if (staleStandbys.length > 0) return { kind: 'restart', phase: 'standby', services: staleStandbys, preload };
  const staleWriters = stale(writers);
  if (staleWriters.length > 0) {
    const back = waiting(standbys);
    if (back.length > 0) return { kind: 'verify', phase: 'standby', services: back, preload };
    if (!i.writersRedeployable) {
      return { kind: 'blocked', reason: 'the main copy keeps its data on a temporary volume; migrate its storage first' };
    }
    return { kind: 'restart', phase: 'writer', services: staleWriters, preload };
  }

  const toCreate = i.wanted.filter((n) => !i.applied.includes(n));
  if (toCreate.length === 0) return { kind: 'steady' };
  if (i.failedFor !== null && i.failedFor === encodeExtList(i.wanted)) {
    return { kind: 'blocked', reason: 'CREATE EXTENSION failed; change the selection to try again' };
  }
  if (!i.primaryRunning) return { kind: 'blocked', reason: 'the main copy is not running' };
  if (toCreate.some((n) => PG_EXTENSION_CATALOG[n].preload)) {
    const back = waiting(writers);
    if (back.length > 0) return { kind: 'verify', phase: 'writer', services: back, preload };
  }
  return { kind: 'create', names: toCreate };
}

function envOf(env: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env ?? []) {
    const k = kv.indexOf('=');
    out[k >= 0 ? kv.slice(0, k) : kv] = k >= 0 ? kv.slice(k + 1) : '';
  }
  return out;
}

/** One live member → the planner's view (`verified` decided by the caller). */
export function extMemberOf(s: ExtServiceLike, phase: ExtPhase, verified: boolean): ExtMember {
  const updating = s.updateStatus === 'updating' || s.updateStatus === 'rollback_started' || s.updateStatus === 'paused';
  return {
    service: s.name,
    phase,
    specPreload: envPreload(envOf(s.env)),
    desired: s.desiredReplicas ?? 1,
    running: s.runningReplicas,
    updating,
    verified,
  };
}

/** The label half of the plan input, read off the primary. */
export function extLabelsOf(primary: ExtServiceLike): Pick<ExtPlanInput, 'wanted' | 'applied' | 'failedFor'> {
  return {
    wanted: parseExtList(primary.labels[DB_EXTENSIONS_LABEL]),
    applied: parseExtList(primary.labels[DB_EXTENSIONS_APPLIED_LABEL]),
    failedFor: parseExtError(primary.labels[DB_EXTENSIONS_ERROR_LABEL])?.wanted ?? null,
  };
}

/** Deterministic signature of everything the planner reads except `verified` (the steady gate). */
export function extSignature(i: ExtPlanInput): string {
  return JSON.stringify([i.wanted, i.applied, i.failedFor, i.primaryRunning, i.writersRedeployable,
    i.members.map((m) => [m.service, m.phase, m.specPreload, m.desired, m.running, m.updating])]);
}
