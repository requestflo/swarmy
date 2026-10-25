import {
  PG_SHARED_BUFFERS_SQL,
  expectedSharedBuffersMb,
  memMemberOf,
  memSignature,
  parsePgSizeMb,
  pgMemberSqlScript,
  planPgMemory,
  wantedMemoryOf,
  type MemPhase,
  type MemStep,
} from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';

/**
 * Managed Postgres memory — the manageddb reconcile's per-cluster step after
 * the extensions step has nothing to do. The plan is pure (`planPgMemory` in
 * @swarmy/core: standbys first, the writer last and in place); this file runs
 * ONE step per tick through the seams the reconcile hands it, so the spec
 * builders stay the reconcile's own (every rebuild through `applyPgMember`,
 * which derives the limit and shared_buffers from the applied label).
 *
 *   - steady gate: the plan input's signature is held per cluster; an
 *     unchanged signature after a `steady` plan sends nothing.
 *   - verify: `SHOW shared_buffers` in a restarted standby; the answer is
 *     remembered in memory until that member is restarted again.
 */

export interface MemCluster {
  key: string;
  primary: SwarmServiceInfo;
  standbys: SwarmServiceInfo[];
  /** Writers other than the primary (active-active). */
  extraWriters: SwarmServiceInfo[];
}

export interface MemSeams {
  exec(svc: SwarmServiceInfo, script: string): Promise<{ exitCode: number; output: string } | null>;
  deploy(spec: ServiceSpec): Promise<unknown>;
  /** The member rebuilt with `swarmy.db.memoryMb.applied=<mb>` (none for null); a writer also stamps `plannedAt`. */
  restartSpec(member: SwarmServiceInfo, memoryMb: number | null, plannedAt?: string): ServiceSpec;
  audit(action: string, metadata: Record<string, unknown>): Promise<unknown>;
  /** False for a primary on temporary storage (never restarted). */
  writersRedeployable: boolean;
}

const verified = new Set<string>();
const lastSteady = new Map<string, string>();
const verifyKey = (svc: string, mb: number | null) => `${svc}|${mb ?? 'none'}`;

export async function convergePgMemory(c: MemCluster, seams: MemSeams, now = Date.now()): Promise<MemStep> {
  const wantedMb = wantedMemoryOf(c.primary);
  const member = (s: SwarmServiceInfo, phase: MemPhase) => {
    const m = memMemberOf(s, phase, false);
    return { ...m, verified: verified.has(verifyKey(s.name, m.appliedMb)) };
  };
  const input = {
    wantedMb,
    writersRedeployable: seams.writersRedeployable,
    members: [
      member(c.primary, 'writer'),
      ...c.extraWriters.map((s) => member(s, 'writer')),
      ...c.standbys.map((s) => member(s, 'standby')),
    ],
  };
  const signature = memSignature(input);
  if (lastSteady.get(c.key) === signature) return { kind: 'steady' };
  const step = planPgMemory(input);
  const all = [c.primary, ...c.extraWriters, ...c.standbys];

  switch (step.kind) {
    case 'steady':
      lastSteady.set(c.key, signature);
      return step;
    case 'blocked':
      return step;
    case 'verify': {
      const want = expectedSharedBuffersMb(step.memoryMb);
      for (const name of step.services) {
        const svc = all.find((s) => s.name === name);
        if (!svc || (svc.runningReplicas ?? 0) < (svc.desiredReplicas ?? 1)) continue;
        if (want === null) {
          verified.add(verifyKey(name, step.memoryMb));
          continue;
        }
        const res = await seams.exec(svc, pgMemberSqlScript(PG_SHARED_BUFFERS_SQL));
        if (res && res.exitCode === 0 && parsePgSizeMb(res.output) === want) verified.add(verifyKey(name, step.memoryMb));
      }
      return step;
    }
    case 'restart': {
      const plannedAt = step.phase === 'writer' ? new Date(now).toISOString() : undefined;
      for (const name of step.services) {
        const svc = all.find((s) => s.name === name);
        if (!svc) continue;
        for (const k of [...verified]) if (k.startsWith(`${name}|`)) verified.delete(k);
        await seams.deploy(seams.restartSpec(svc, step.memoryMb, plannedAt));
      }
      await seams.audit('db.memory.restart', { phase: step.phase, services: step.services, memoryMb: step.memoryMb, inPlace: true });
      return step;
    }
  }
}

/** Test seam: forget remembered verifications + steady signatures. */
export function resetMemoryState(): void {
  verified.clear();
  lastSteady.clear();
}
