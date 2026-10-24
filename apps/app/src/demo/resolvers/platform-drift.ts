import type { DemoHandler, DemoStore } from '../types';

/**
 * Settings › Platform → "Not on the release", in the demo: swarmy-dns runs a
 * floating tag (Re-pin puts it back) and object storage is on another build
 * (Explain says why it waits for an upgrade). Mirrors PlatformDriftView
 * (platform-drift.service.ts).
 */
const D = (c: string) => `sha256:${c.repeat(64)}`;

const ROWS = [
  {
    service: 'swarmy-dns',
    key: 'dns',
    owner: 'system',
    running: 'ghcr.io/requestflo/swarmy-dns:latest',
    expected: `ghcr.io/requestflo/swarmy-dns@${D('d')}`,
    kind: 'floating',
    action: 'repin',
  },
  {
    service: 'swarmy-garage',
    key: 'garage',
    owner: 'engine',
    running: `dxflrs/garage:v2.4.1@${D('7')}`,
    expected: `docker.io/dxflrs/garage@${D('9')}`,
    kind: 'digest',
    action: 'explain',
  },
] as const;

function repinned(s: DemoStore): string[] {
  const e = s.extra as Record<string, unknown>;
  e.platformRepinned ??= [];
  return e.platformRepinned as string[];
}

function current(s: DemoStore): string {
  const p = (s.extra as Record<string, { current?: string } | undefined>).platform;
  return p?.current ?? '1.2.4';
}

export const driftResolvers: Record<string, DemoHandler> = {
  'platform.drift': (_i, s) => {
    const run = (s.extra as Record<string, { run?: { finishedAt: string | null } | null } | undefined>).platform?.run;
    const done = repinned(s);
    return {
      version: current(s),
      builtIn: false,
      runActive: Boolean(run && !run.finishedAt),
      rows: ROWS.filter((r) => !done.includes(r.service)),
    };
  },
  'platform.repin': (i, s) => {
    const { service } = i as { service: string };
    const row = ROWS.find((r) => r.service === service);
    if (!row || row.action !== 'repin') throw new Error(`${service} is not re-pinned from here — it moves with an upgrade`);
    repinned(s).push(service);
    return { service, to: row.expected, landed: true, state: 'completed' };
  },
};
