import type { ContainerHealth, HealthProbe } from './protocol/containers';

/**
 * Docker's health record for one container, read off container inspect
 * (`State.Health` + `Config.Healthcheck.Test`) into the compact wire shape
 * the agent's container snapshot carries. PURE — unit-tested beside it.
 * Docker keeps the last 5 probes; nothing here invents more.
 */

const OUTPUT_MAX = 300;
const STATUS = new Set(['starting', 'healthy', 'unhealthy', 'none']);

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** RFC 3339 with nanoseconds → ms since epoch, keeping the sub-millisecond part. */
export function rfc3339Ms(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined;
  const m = /^(.+T\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : undefined;
  }
  const base = Date.parse(`${m[1]}${m[3]}`);
  return Number.isFinite(base) ? base + (m[2] ? Number(m[2]) * 1000 : 0) : undefined;
}

/** The health word in `docker ps` Status ("Up 3 min (healthy)"), or null when the container has no check. */
export function psHealthWord(status: string): ContainerHealth['status'] | null {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status);
  if (!m) return null;
  return m[1] === 'health: starting' ? 'starting' : (m[1] as 'healthy' | 'unhealthy');
}

function probeOf(raw: unknown): HealthProbe | null {
  const p = obj(raw);
  const start = rfc3339Ms(p?.Start);
  const end = rfc3339Ms(p?.End);
  if (!p || start === undefined || end === undefined || typeof p.ExitCode !== 'number') return null;
  const output = typeof p.Output === 'string' ? p.Output.trim() : '';
  return {
    at: Math.round(start),
    durationMs: Math.max(0, Math.round((end - start) * 10) / 10),
    exitCode: p.ExitCode,
    ...(p.ExitCode !== 0 && output ? { output: output.length > OUTPUT_MAX ? `${output.slice(0, OUTPUT_MAX - 1)}…` : output } : {}),
  };
}

/** container inspect → `ContainerHealth`, or undefined when the container has no health record. */
export function healthFromInspect(inspect: unknown): ContainerHealth | undefined {
  const root = obj(inspect);
  const h = obj(obj(root?.State)?.Health);
  if (!h || typeof h.Status !== 'string' || !STATUS.has(h.Status)) return undefined;
  const test = obj(obj(root?.Config)?.Healthcheck)?.Test;
  const probes = (Array.isArray(h.Log) ? h.Log : []).map(probeOf).filter((p): p is HealthProbe => p !== null);
  return {
    status: h.Status as ContainerHealth['status'],
    failingStreak: typeof h.FailingStreak === 'number' ? h.FailingStreak : 0,
    ...(Array.isArray(test) ? { test: test.filter((t): t is string => typeof t === 'string') } : {}),
    probes: probes.slice(-10),
  };
}

/** One running copy's health, as `services.healthProbes` returns it. */
export interface HealthCopyView {
  nodeId: string;
  /** The server's hostname, when the hub knows it. */
  node: string | null;
  containerId: string;
  status: ContainerHealth['status'];
  failingStreak: number;
  probes: HealthProbe[];
}

/** `services.healthProbes`: Docker's last probes for every running copy, newest copies first. */
export interface ServiceHealthProbesView {
  copies: HealthCopyView[];
  /** The check the copies actually run (the image's own when the service sets none). */
  test: string[] | null;
}

/** `services.testHealthcheck`: the check run once, now, inside one running copy. */
export interface HealthTestView {
  ok: boolean;
  /** null when it never finished (timed out). */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** stdout (+ stderr on failure), trimmed. */
  output: string;
  at: number;
  node: string | null;
  containerId: string;
  /** The argv that ran. */
  cmd: string[];
}
