import { describe, expect, it } from 'bun:test';
import { healthFromInspect, psHealthWord, rfc3339Ms } from './container-health';
import { ContainerInfo } from './protocol/containers';

const INSPECT = {
  Config: { Healthcheck: { Test: ['CMD-SHELL', 'curl -fsS http://localhost:3000/health'], Interval: 10e9 } },
  State: {
    Status: 'running',
    Health: {
      Status: 'healthy',
      FailingStreak: 0,
      Log: [
        { Start: '2026-10-24T10:31:00.100000000Z', End: '2026-10-24T10:31:00.104200000Z', ExitCode: 0, Output: 'ok' },
        { Start: '2026-10-24T10:31:10.000000000Z', End: '2026-10-24T10:31:10.212000000Z', ExitCode: 1, Output: '  curl: (7) Failed to connect\n' },
        { Start: 'garbage', End: '2026-10-24T10:31:20Z', ExitCode: 0 },
      ],
    },
  },
};

describe('healthFromInspect — Docker’s own record, never more', () => {
  it('maps status, streak, the effective test and the kept probes', () => {
    expect(healthFromInspect(INSPECT)).toEqual({
      status: 'healthy',
      failingStreak: 0,
      test: ['CMD-SHELL', 'curl -fsS http://localhost:3000/health'],
      probes: [
        { at: Date.parse('2026-10-24T10:31:00.100Z'), durationMs: 4.2, exitCode: 0 },
        { at: Date.parse('2026-10-24T10:31:10Z'), durationMs: 212, exitCode: 1, output: 'curl: (7) Failed to connect' },
      ],
    });
  });

  it('a container without a check has no record', () => {
    expect(healthFromInspect({ State: { Status: 'running' } })).toBeUndefined();
    expect(healthFromInspect({ State: { Health: { Status: 'weird' } } })).toBeUndefined();
    expect(healthFromInspect(null)).toBeUndefined();
  });

  it('long failure output is trimmed for the wire', () => {
    const h = healthFromInspect({ State: { Health: { Status: 'unhealthy', FailingStreak: 4, Log: [{ Start: '2026-10-24T10:00:00Z', End: '2026-10-24T10:00:01Z', ExitCode: 1, Output: 'x'.repeat(5000) }] } } });
    expect(h?.probes[0]?.output?.length).toBe(300);
    expect(h?.failingStreak).toBe(4);
    expect(ContainerInfo.shape.health.safeParse(h).success).toBe(true);
  });
});

describe('psHealthWord / rfc3339Ms', () => {
  it('reads the health word docker ps puts in Status', () => {
    expect(psHealthWord('Up 3 minutes (healthy)')).toBe('healthy');
    expect(psHealthWord('Up 5 seconds (health: starting)')).toBe('starting');
    expect(psHealthWord('Up 2 hours (unhealthy)')).toBe('unhealthy');
    expect(psHealthWord('Up 2 hours')).toBeNull();
  });

  it('keeps sub-millisecond precision', () => {
    expect(rfc3339Ms('1970-01-01T00:00:00.0005Z')).toBe(0.5);
    expect(rfc3339Ms(42)).toBeUndefined();
  });
});

describe('ContainerInfo.health on the wire (additive)', () => {
  const base = { id: 'c1', name: 'web.1', image: 'web:1', state: 'running', status: 'Up', createdAt: 1, ports: [], labels: {} };
  it('an older agent’s frame (no health) still parses, with no health', () => {
    const r = ContainerInfo.safeParse(base);
    expect(r.success && r.data.health).toBeUndefined();
  });
  it('defaults the streak and probes, rejects a bad status', () => {
    const r = ContainerInfo.parse({ ...base, health: { status: 'starting' } });
    expect(r.health).toEqual({ status: 'starting', failingStreak: 0, probes: [] });
    expect(ContainerInfo.safeParse({ ...base, health: { status: 'fine' } }).success).toBe(false);
  });
});
