import type { ServiceSpec } from '@swarmy/core/protocol';
import { toYaml } from '@/components/calm';
import { fmtCpu, fmtMem, sayDuration } from './settings-model';

type Json = Parameters<typeof toYaml>[0];

/** A resource side in compose words ({ cpus: "0.5", memory: 768M }). */
function side(s: { cpus?: number; memoryBytes?: number } | undefined): Json | undefined {
  if (!s || (s.cpus === undefined && s.memoryBytes === undefined)) return undefined;
  return {
    cpus: s.cpus !== undefined ? fmtCpu(s.cpus) : undefined,
    memory: s.memoryBytes !== undefined ? fmtMem(s.memoryBytes) : undefined,
  };
}

/**
 * One service's live spec as compose (the keys `docker stack deploy` reads).
 * Variables are left out (they live on Config › Variables & secrets).
 */
export function composeOf(short: string, spec: ServiceSpec): string {
  const cmd = [...(spec.command ?? []), ...(spec.args ?? [])];
  const hc = spec.healthcheck;
  const res = spec.resources;
  const rp = spec.restartPolicy;
  const uc = spec.updateConfig;
  const body: Json = {
    image: spec.image,
    command: cmd.length ? cmd : undefined,
    healthcheck:
      hc && !hc.disable && hc.test?.length
        ? {
            test: hc.test,
            interval: sayDuration(hc.intervalNs),
            start_period: sayDuration(hc.startPeriodNs),
            retries: hc.retries,
          }
        : undefined,
    deploy: {
      mode: spec.mode?.global ? 'global' : undefined,
      replicas: spec.mode?.global ? undefined : (spec.mode?.replicated?.replicas ?? 1),
      resources: res ? { reservations: side(res.reservations), limits: side(res.limits) } : undefined,
      restart_policy: rp
        ? { condition: rp.condition, max_attempts: rp.maxAttempts, delay: sayDuration(rp.delayNs) }
        : undefined,
      update_config: uc
        ? { parallelism: uc.parallelism, order: uc.order, failure_action: uc.failureAction, delay: sayDuration(uc.delayNs) }
        : undefined,
      labels: spec.labels && Object.keys(spec.labels).length ? spec.labels : undefined,
    },
    networks: spec.networks?.length ? spec.networks : undefined,
  };
  return toYaml({ services: { [short]: body } });
}

/**
 * Line numbers (0-based) in `next` that are new or changed against `base` —
 * the longest-common-subsequence of lines, so an inserted key marks only its
 * own lines.
 */
export function changedLines(base: string, next: string): Set<number> {
  const a = base.split('\n');
  const b = next.split('\n');
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out = new Set<number>();
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      out.add(j);
      j++;
    }
  }
  return out;
}
