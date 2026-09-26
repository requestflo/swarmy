import type { UpdateServiceInput } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';

/**
 * The service settings knobs (board ServiceSheet): resources, "if it crashes",
 * "during a deploy". PURE — applied inside `updateService`'s patch transform
 * over the FULL live spec, so every field the input doesn't name is carried.
 * Docker is the truth: these are service spec fields, never DB rows.
 */
export function applyServiceSettings(
  live: ServiceSpec,
  input: Pick<UpdateServiceInput, 'resources' | 'restartPolicy' | 'updateOrder'>,
): ServiceSpec {
  const out: ServiceSpec = { ...live };

  if (input.resources) {
    const next: NonNullable<ServiceSpec['resources']> = { ...(live.resources ?? {}) };
    for (const side of ['limits', 'reservations'] as const) {
      const v = input.resources[side];
      if (v === undefined) continue;
      const clean = v ? { ...(v.cpus !== undefined ? { cpus: v.cpus } : {}), ...(v.memoryBytes !== undefined ? { memoryBytes: v.memoryBytes } : {}) } : {};
      if (Object.keys(clean).length > 0) next[side] = clean;
      else delete next[side];
    }
    if (next.limits || next.reservations) out.resources = next;
    else delete out.resources;
  }

  if (input.restartPolicy) {
    const { condition, maxAttempts, delaySeconds } = input.restartPolicy;
    const base = live.restartPolicy ?? {};
    out.restartPolicy = {
      ...base,
      condition,
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      ...(delaySeconds !== undefined ? { delayNs: Math.round(delaySeconds * 1e9) } : {}),
    };
    // "Never" restarts: attempts/delay mean nothing, drop them.
    if (condition === 'none') {
      delete out.restartPolicy.maxAttempts;
      delete out.restartPolicy.delayNs;
    }
  }

  if (input.updateOrder) {
    out.updateConfig = { ...(live.updateConfig ?? {}), order: input.updateOrder };
  }
  return out;
}

/** Labels swarmy itself owns on every managed service; a settings edit can't drop them. */
const PROTECTED_LABELS = new Set(['swarmy.managed', 'com.docker.stack.namespace']);

/** The label edits a caller may make (protected keys filtered out of removals). */
export function labelEdits(input: Pick<UpdateServiceInput, 'setLabels' | 'removeLabels'>): {
  setLabels: Record<string, string>;
  removeLabels: string[];
} {
  return {
    setLabels: input.setLabels ?? {},
    removeLabels: (input.removeLabels ?? []).filter((k) => !PROTECTED_LABELS.has(k)),
  };
}
