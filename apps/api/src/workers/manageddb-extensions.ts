import {
  DB_EXTENSIONS_APPLIED_LABEL,
  DB_EXTENSIONS_AVAILABLE_LABEL,
  DB_EXTENSIONS_ERROR_LABEL,
  DB_EXTENSIONS_PROBED_LABEL,
  PG_EXTENSIONS_PROBE_SQL,
  PG_PRELOAD_SQL,
  encodeExtList,
  extLabelsOf,
  extMemberOf,
  extSignature,
  extensionSql,
  normalizePreload,
  parseExtList,
  pgMemberSqlScript,
  planPgExtensions,
  type ExtPhase,
  type ExtStep,
} from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';

/**
 * Managed Postgres extensions — the manageddb reconcile's per-cluster step
 * (pg_stat_statements, postgis). The plan is pure (`planPgExtensions` in
 * @swarmy/core); this file runs ONE step per tick through the seams the
 * reconcile hands it, so the spec builders stay the reconcile's own (every
 * rebuild through `applyPgMember`).
 *
 *   - probe: once per image, which catalog extensions the image ships
 *     (`pg_available_extensions`) → `swarmy.db.extensions.available`.
 *   - steady gate: the plan input's signature is held per cluster; an unchanged
 *     signature after a `steady` plan sends nothing (no exec, no label write).
 *   - verify: `SHOW shared_preload_libraries` in a restarted member; the answer
 *     is remembered in memory until that member is restarted again.
 */

export interface ExtCluster {
  key: string;
  ref: string;
  primary: SwarmServiceInfo;
  standbys: SwarmServiceInfo[];
  /** Writers other than the primary (active-active). */
  extraWriters: SwarmServiceInfo[];
}

export interface ExtSeams {
  exec(svc: SwarmServiceInfo, script: string): Promise<{ exitCode: number; output: string } | null>;
  setLabels(service: string, add: Record<string, string>, removeKeys?: string[]): Promise<unknown>;
  deploy(spec: ServiceSpec): Promise<unknown>;
  /** The member's spec with `SWARMY_PG_PRELOAD=<preload>`; a writer restart also stamps `plannedAt`. */
  restartSpec(member: SwarmServiceInfo, preload: string, plannedAt?: string): ServiceSpec;
  audit(action: string, metadata: Record<string, unknown>): Promise<unknown>;
  /** False for a primary on temporary storage (never restarted). */
  writersRedeployable: boolean;
}

const verified = new Set<string>();
const lastSteady = new Map<string, string>();
const verifyKey = (svc: string, preload: string) => `${svc}|${preload}`;

export async function convergePgExtensions(c: ExtCluster, seams: ExtSeams, now = Date.now()): Promise<ExtStep | null> {
  const { primary } = c;
  const primaryRunning = (primary.runningReplicas ?? 0) > 0;

  // Probe once per image (the UI's "needs a postgis image" is this answer).
  if (primaryRunning && primary.labels[DB_EXTENSIONS_PROBED_LABEL] !== primary.image) {
    const res = await seams.exec(primary, pgMemberSqlScript(PG_EXTENSIONS_PROBE_SQL));
    if (res && res.exitCode === 0) {
      await seams.setLabels(primary.name, {
        [DB_EXTENSIONS_AVAILABLE_LABEL]: encodeExtList(parseExtList(res.output.trim())) || 'none',
        [DB_EXTENSIONS_PROBED_LABEL]: primary.image,
      });
    }
    return null;
  }

  const labels = extLabelsOf(primary);
  const member = (s: SwarmServiceInfo, phase: ExtPhase) => {
    const m = extMemberOf(s, phase, false);
    return { ...m, verified: verified.has(verifyKey(s.name, m.specPreload)) };
  };
  const input = {
    ...labels,
    primaryRunning,
    writersRedeployable: seams.writersRedeployable,
    members: [
      member(primary, 'writer'),
      ...c.extraWriters.map((s) => member(s, 'writer')),
      ...c.standbys.map((s) => member(s, 'standby')),
    ],
  };
  const signature = extSignature(input);
  if (lastSteady.get(c.key) === signature) return { kind: 'steady' };
  const step = planPgExtensions(input);
  const all = [primary, ...c.extraWriters, ...c.standbys];

  switch (step.kind) {
    case 'steady':
      lastSteady.set(c.key, signature);
      return step;
    case 'blocked':
      return step;
    case 'verify':
      for (const name of step.services) {
        const svc = all.find((s) => s.name === name);
        if (!svc) continue;
        const res = await seams.exec(svc, pgMemberSqlScript(PG_PRELOAD_SQL));
        if (res && res.exitCode === 0 && normalizePreload(res.output.trim()) === step.preload) {
          verified.add(verifyKey(name, step.preload));
        }
      }
      return step;
    case 'restart': {
      const plannedAt = step.phase === 'writer' ? new Date(now).toISOString() : undefined;
      for (const name of step.services) {
        const svc = all.find((s) => s.name === name);
        if (!svc) continue;
        for (const k of [...verified]) if (k.startsWith(`${name}|`)) verified.delete(k);
        await seams.deploy(seams.restartSpec(svc, step.preload, plannedAt));
      }
      await seams.audit('db.extension.restart', { phase: step.phase, services: step.services, preload: step.preload || null, inPlace: true });
      return step;
    }
    case 'drop':
    case 'create': {
      const on = step.kind === 'create';
      const done: string[] = [];
      for (const name of step.names) {
        const res = await seams.exec(primary, pgMemberSqlScript(extensionSql(name, on)));
        if (!res) return step; // not reachable this tick: retry
        if (res.exitCode !== 0) {
          const message = res.output.trim().slice(0, 200) || `exit ${res.exitCode}`;
          await seams.setLabels(primary.name, { [DB_EXTENSIONS_ERROR_LABEL]: `${encodeExtList(labels.wanted)}|${name}: ${message}` });
          await seams.audit(on ? 'db.extension.create.failed' : 'db.extension.drop.failed', { extension: name, error: message });
          return step;
        }
        done.push(name);
      }
      const applied = on ? [...labels.applied, ...step.names] : labels.applied.filter((n) => !step.names.includes(n));
      const list = encodeExtList(applied);
      await seams.setLabels(
        primary.name,
        list ? { [DB_EXTENSIONS_APPLIED_LABEL]: list } : {},
        list ? [DB_EXTENSIONS_ERROR_LABEL] : [DB_EXTENSIONS_ERROR_LABEL, DB_EXTENSIONS_APPLIED_LABEL],
      );
      await seams.audit(on ? 'db.extension.create' : 'db.extension.drop', { extensions: done, primary: primary.name });
      return step;
    }
  }
}

/** Test seam: forget remembered verifications + steady signatures. */
export function resetExtensionState(): void {
  verified.clear();
  lastSteady.clear();
}
