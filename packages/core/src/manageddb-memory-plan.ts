/**
 * PURE — the one next step that brings every copy of a managed Postgres
 * cluster to the memory its primary's `swarmy.db.memoryMb` label asks for.
 * The manageddb reconcile runs one step per tick (after the extensions step
 * has nothing to do); at steady state the answer is `steady` and nothing is
 * sent. A new limit needs a restart: Docker applies a memory limit and
 * Postgres reads shared_buffers only when a copy starts.
 *
 * Order (the failover rules: the writer is never the first thing touched):
 *   1. restart standbys — every standby whose applied memory differs is
 *      redeployed with the new limit and settings.
 *   2. verify standbys — each is back, running, and `SHOW shared_buffers`
 *      matches its new size; only then
 *   3. restart writers — in place, on their own data, under
 *      `swarmy.db.restart.planned` (no promotion, so no data-loss window; a
 *      few seconds without writes). A writer on temporary storage is never
 *      restarted.
 */
import { DB_MEMORY_APPLIED_LABEL, DB_MEMORY_LABEL, parseMemoryMb, pgMemorySettings } from './manageddb-memory';

export type MemPhase = 'standby' | 'writer';

export interface MemMember {
  service: string;
  phase: MemPhase;
  /** `swarmy.db.memoryMb.applied` on the member (null = no limit). */
  appliedMb: number | null;
  desired: number;
  running: number;
  updating: boolean;
  /** Answered `SHOW shared_buffers` with its applied size since its last restart. */
  verified: boolean;
}

export interface MemPlanInput {
  wantedMb: number | null;
  writersRedeployable: boolean;
  members: MemMember[];
}

export type MemStep =
  | { kind: 'steady' }
  | { kind: 'restart' | 'verify'; phase: MemPhase; services: string[]; memoryMb: number | null }
  | { kind: 'blocked'; reason: string };

const isBack = (m: MemMember) => m.desired === 0 || (m.running >= m.desired && !m.updating && m.verified);

export function planPgMemory(i: MemPlanInput): MemStep {
  const stale = (phase: MemPhase) => i.members.filter((m) => m.phase === phase && m.appliedMb !== i.wantedMb).map((m) => m.service);
  const standbys = stale('standby');
  if (standbys.length > 0) return { kind: 'restart', phase: 'standby', services: standbys, memoryMb: i.wantedMb };
  const writers = stale('writer');
  if (writers.length === 0) return { kind: 'steady' };
  const waiting = i.members.filter((m) => m.phase === 'standby' && !isBack(m)).map((m) => m.service);
  if (waiting.length > 0) return { kind: 'verify', phase: 'standby', services: waiting, memoryMb: i.wantedMb };
  if (!i.writersRedeployable) {
    return { kind: 'blocked', reason: 'the main copy keeps its data on a temporary volume; migrate its storage first' };
  }
  return { kind: 'restart', phase: 'writer', services: writers, memoryMb: i.wantedMb };
}

/** The structural subset of a live service the planner reads. */
export interface MemServiceLike {
  name: string;
  labels: Record<string, string>;
  desiredReplicas?: number;
  runningReplicas: number;
  updateStatus?: string;
}

export function memMemberOf(s: MemServiceLike, phase: MemPhase, verified: boolean): MemMember {
  return {
    service: s.name,
    phase,
    appliedMb: parseMemoryMb(s.labels[DB_MEMORY_APPLIED_LABEL]),
    desired: s.desiredReplicas ?? 1,
    running: s.runningReplicas,
    updating: s.updateStatus === 'updating' || s.updateStatus === 'rollback_started' || s.updateStatus === 'paused',
    verified,
  };
}

export function wantedMemoryOf(primary: MemServiceLike): number | null {
  return parseMemoryMb(primary.labels[DB_MEMORY_LABEL]);
}

/** shared_buffers a member restarted at `memoryMb` must answer (null = Postgres's own default, not checked). */
export function expectedSharedBuffersMb(memoryMb: number | null): number | null {
  return memoryMb === null ? null : pgMemorySettings(memoryMb).sharedBuffersMb;
}

/** Deterministic signature of everything the planner reads except `verified` (the steady gate). */
export function memSignature(i: MemPlanInput): string {
  return JSON.stringify([i.wantedMb, i.writersRedeployable, i.members.map((m) => [m.service, m.phase, m.appliedMb, m.desired, m.running, m.updating])]);
}
