import { diffEnv, looksSecret, type EnvDiffRow } from '@swarmy/core';

/**
 * Where a paste goes (board 58) and what it may touch. PURE — unit-tested.
 *
 * - One environment: that environment's copy of the service, as a dashboard
 *   override there (merge, or Replace all).
 * - Every environment (shared): the paste is the shared value, so it lands
 *   on every environment's copy of the service the way swarmy.yaml's
 *   `env:` does under `environments.<name>.env` — an environment that sets
 *   its own value (one that differs from production's) keeps it. Merge only:
 *   Replace all works on one environment at a time.
 * - A variable swarmy.yaml declares for that service there is LOCKED in
 *   every mode: never overwritten, never removed. It shows with the path
 *   that sets it ("declared in swarmy.yaml; change it there").
 */
export const SHARED = '*';

export interface PasteEnvSide {
  environment: string;
  stack: string;
  /** The service's id in this environment's stack. */
  serviceId: string;
  current: Record<string, string>;
  /** key → the swarmy.yaml path that sets it (apps.declaredEnv). */
  declared: Record<string, string>;
}

export type PasteRowKind = EnvDiffRow['kind'] | 'locked' | 'kept';

export interface PasteRow extends Omit<EnvDiffRow, 'kind'> {
  kind: PasteRowKind;
  /** locked: the swarmy.yaml path; kept: why the environment keeps its own. */
  why?: string;
}

export interface PastePlan {
  environment: string;
  stack: string;
  serviceId: string;
  rows: PasteRow[];
  /** The whole env to deploy. */
  next: Record<string, string>;
  /** Added + changed + removed: 0 = nothing to deploy here. */
  moving: number;
}

export interface PasteInput {
  entries: ReadonlyArray<{ key: string; value: string }>;
  envs: readonly PasteEnvSide[];
  /** An environment name, or SHARED. */
  target: string;
  mode: 'merge' | 'replace';
  /** The environment whose values count as the shared ones (production). */
  base?: string;
}

const MOVING = new Set<PasteRowKind>(['added', 'changed', 'removed']);

function planOne(env: PasteEnvSide, i: PasteInput, shared: Record<string, string> | null, mode: 'merge' | 'replace'): PastePlan {
  const special = new Map<string, PasteRow>();
  for (const e of i.entries) {
    const before = env.current[e.key];
    if (env.declared[e.key]) {
      special.set(e.key, { key: e.key, kind: 'locked', before, after: e.value, secret: looksSecret(e.key, e.value), why: env.declared[e.key] });
    } else if (shared && before !== undefined && before !== shared[e.key] && before !== e.value) {
      special.set(e.key, { key: e.key, kind: 'kept', before, after: e.value, secret: looksSecret(e.key, e.value), why: `${env.environment} sets its own` });
    }
  }
  const d = diffEnv(env.current, i.entries.filter((e) => !special.has(e.key)), mode);
  const next = { ...d.next };
  const rows: PasteRow[] = [];
  for (const r of d.rows) {
    if (special.has(r.key)) continue;
    if (r.kind === 'removed' && env.declared[r.key]) {
      // Replace all never removes what swarmy.yaml declares.
      next[r.key] = r.before ?? '';
      rows.push({ ...r, kind: 'unchanged', after: r.before });
    } else rows.push(r);
  }
  for (const [key, row] of special) {
    if (env.current[key] !== undefined) next[key] = env.current[key]!;
    rows.push(row);
  }
  return { environment: env.environment, stack: env.stack, serviceId: env.serviceId, rows, next, moving: rows.filter((r) => MOVING.has(r.kind)).length };
}

/** One plan per environment the paste goes to (SHARED: every one that runs the service). */
export function planPaste(i: PasteInput): PastePlan[] {
  if (i.target !== SHARED) {
    const env = i.envs.find((e) => e.environment === i.target);
    return env ? [planOne(env, i, null, i.mode)] : [];
  }
  const base = i.envs.find((e) => e.environment === (i.base ?? 'production')) ?? i.envs[0];
  return i.envs.map((e) => planOne(e, i, e === base ? null : (base?.current ?? {}), 'merge'));
}

/** "production and staging" · "production, staging and qa". */
export function envList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
