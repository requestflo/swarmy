import type { UpdateServiceInput } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';

/**
 * The service settings draft (board ServiceSheet): edits build a local draft
 * over the live spec; the apply bar lists the tech diff and sends only the
 * changed fields. PURE — unit-tested in settings-model.test.ts.
 */

export type RestartWhen = 'on-failure' | 'any' | 'none';
export type DeployOrder = 'start-first' | 'stop-first';

export interface SettingsDraft {
  copies?: number;
  /** CPU limit per copy, in cores. */
  cpuLimit?: number;
  /** Memory limit per copy, in bytes. */
  memLimit?: number;
  restart?: RestartWhen;
  order?: DeployOrder;
}

export const MIB = 1024 ** 2;
export const CPU_PRESETS = [0.25, 0.5, 1, 2] as const;
export const MEM_PRESETS = [256 * MIB, 512 * MIB, 768 * MIB, 1024 * MIB] as const;

/** Docker's defaults when the spec doesn't say (RestartPolicy any, UpdateConfig stop-first, 1 at a time). */
export const restartOf = (spec: ServiceSpec | null): RestartWhen => spec?.restartPolicy?.condition ?? 'any';
export const orderOf = (spec: ServiceSpec | null): DeployOrder => spec?.updateConfig?.order ?? 'stop-first';
export const parallelismOf = (spec: ServiceSpec | null): number => {
  const p = spec?.updateConfig?.parallelism;
  return p === undefined || p === 0 ? 1 : p;
};

export function fmtCpu(cores: number | undefined): string {
  return cores === undefined ? '—' : String(Math.round(cores * 100) / 100);
}

/** 768M · 1G · 1.5G — the compose memory dialect. */
export function fmtMem(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  const mib = bytes / MIB;
  if (mib >= 1024 && mib % 512 === 0) return `${mib / 1024}G`;
  if (mib >= 1024) return `${Math.round((mib / 1024) * 10) / 10}G`;
  return `${Math.round(mib)}M`;
}

/** "311 MB" — plain words for Summary. */
export function sayMem(bytes: number): string {
  const mib = bytes / MIB;
  return mib >= 1024 ? `${Math.round((mib / 1024) * 10) / 10} GB` : `${Math.round(mib)} MB`;
}

export function sayDuration(ns: number | undefined): string | undefined {
  if (ns === undefined) return undefined;
  const s = ns / 1e9;
  return s >= 60 && s % 60 === 0 ? `${s / 60}m` : `${Math.round(s * 10) / 10}s`;
}

export interface Change {
  key: string;
  from: string;
  to: string;
}

/** The tech diff the apply bar lists ("limits.memory 512M → 768M"). */
export function draftChanges(spec: ServiceSpec | null, copies: number, d: SettingsDraft): Change[] {
  const out: Change[] = [];
  const lim = spec?.resources?.limits;
  if (d.copies !== undefined && d.copies !== copies) out.push({ key: 'replicas', from: String(copies), to: String(d.copies) });
  if (d.cpuLimit !== undefined && d.cpuLimit !== lim?.cpus) {
    out.push({ key: 'limits.cpus', from: fmtCpu(lim?.cpus), to: fmtCpu(d.cpuLimit) });
  }
  if (d.memLimit !== undefined && d.memLimit !== lim?.memoryBytes) {
    out.push({ key: 'limits.memory', from: fmtMem(lim?.memoryBytes), to: fmtMem(d.memLimit) });
  }
  if (d.restart !== undefined && d.restart !== restartOf(spec)) {
    out.push({ key: 'restart_policy.condition', from: restartOf(spec), to: d.restart });
  }
  if (d.order !== undefined && d.order !== orderOf(spec)) {
    out.push({ key: 'update_config.order', from: orderOf(spec), to: d.order });
  }
  return out;
}

/** The spec the draft would produce — feeds the live compose with changed lines. */
export function applyDraft(spec: ServiceSpec, d: SettingsDraft): ServiceSpec {
  const out: ServiceSpec = { ...spec };
  if (d.copies !== undefined && !spec.mode?.global) out.mode = { replicated: { replicas: d.copies } };
  if (d.cpuLimit !== undefined || d.memLimit !== undefined) {
    const limits = { ...(spec.resources?.limits ?? {}) };
    if (d.cpuLimit !== undefined) limits.cpus = d.cpuLimit;
    if (d.memLimit !== undefined) limits.memoryBytes = d.memLimit;
    out.resources = { ...(spec.resources ?? {}), limits };
  }
  if (d.restart !== undefined) out.restartPolicy = { ...(spec.restartPolicy ?? {}), condition: d.restart };
  if (d.order !== undefined) out.updateConfig = { ...(spec.updateConfig ?? {}), order: d.order };
  return out;
}

/**
 * Only the changed fields: `update` for the spec knobs (`services.update`),
 * `copies` for the count (`services.scale`). Null when nothing changed there.
 */
export function toCalls(
  id: string,
  spec: ServiceSpec | null,
  copies: number,
  d: SettingsDraft,
): { update: UpdateServiceInput | null; copies: number | null } {
  const keys = new Set(draftChanges(spec, copies, d).map((c) => c.key));
  const update: UpdateServiceInput = { id };
  if (keys.has('limits.cpus') || keys.has('limits.memory')) {
    const lim = spec?.resources?.limits;
    const cpus = keys.has('limits.cpus') ? d.cpuLimit : lim?.cpus;
    const memoryBytes = keys.has('limits.memory') ? d.memLimit : lim?.memoryBytes;
    update.resources = {
      limits: { ...(cpus !== undefined ? { cpus } : {}), ...(memoryBytes !== undefined ? { memoryBytes } : {}) },
    };
  }
  if (keys.has('restart_policy.condition') && d.restart) update.restartPolicy = { condition: d.restart };
  if (keys.has('update_config.order') && d.order) update.updateOrder = d.order;
  return {
    update: Object.keys(update).length > 1 ? update : null,
    copies: keys.has('replicas') && d.copies !== undefined ? d.copies : null,
  };
}

/**
 * How long a rolling change takes, honestly: batches of `parallelism` copies,
 * each waiting for the health check to pass (start period + one interval) plus
 * the update delay. Null when there's no health check to time it by — then
 * the bar says no number rather than invent one.
 */
export function rolloutSeconds(spec: ServiceSpec | null, copies: number): number | null {
  const hc = spec?.healthcheck;
  if (!spec || !hc || hc.disable || hc.intervalNs === undefined || copies <= 0) return null;
  const perBatch = ((hc.startPeriodNs ?? 0) + hc.intervalNs + (spec.updateConfig?.delayNs ?? 0)) / 1e9;
  return Math.round(Math.ceil(copies / parallelismOf(spec)) * perBatch);
}

/** "1 change · rolling, 1 copy at a time · ~50 s". */
export function applySentence(spec: ServiceSpec | null, copies: number, changes: Change[]): string {
  const n = `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`;
  const rolling = changes.some((c) => c.key !== 'replicas');
  if (!rolling) return `${n} · copies change in place, nothing restarts`;
  const p = parallelismOf(spec);
  const secs = rolloutSeconds(spec, copies);
  return `${n} · rolling, ${p} ${p === 1 ? 'copy' : 'copies'} at a time${secs ? ` · ~${secs} s` : ''}`;
}
