import type { DemoStore, DomainResolvers } from '../types';

/**
 * Settings → Platform demo: v1.2.4 on Stable with v1.3.0 ready (signed,
 * verified, a Garage major inside). "Start upgrade" plays the run through its
 * steps on each poll. Mirrors PlatformStatusView (platform-upgrade.service.ts).
 */
const KEYS = ['preflight', 'controller', 'agents', 'system', 'engines', 'verify'] as const;
const DETAIL: Record<string, string> = {
  preflight: '4 server(s) online, quorum ok, backup taken',
  controller: 'the new controller is up and resumed the run',
  agents: '4 agent(s) upgraded, one at a time',
  system: '3 system service(s) upgraded',
  engines: 'object storage on dxflrs/garage:v2.4.1',
  verify: '4 server(s) online, system services converged',
};

interface DemoPlatform {
  policy: { channel: 'stable' | 'edge'; feedUrl: string | null; autoApplyPatches: boolean; window: { days: number[]; startHour: number; hours: number } };
  current: string;
  run: null | { id: string; startedAt: string; ticks: number; finishedAt: string | null };
  history: Array<{ id: string; fromVersion: string; toVersion: string; status: string; trigger: string; startedAt: string; finishedAt: string | null; error: string | null; step: string }>;
}

function state(s: DemoStore): DemoPlatform {
  const e = s.extra as Record<string, unknown>;
  e.platform ??= {
    policy: { channel: 'stable', feedUrl: null, autoApplyPatches: false, window: { days: [0], startHour: 2, hours: 2 } },
    current: '1.2.4',
    run: null,
    history: [
      { id: 'pr0', fromVersion: '1.2.3', toVersion: '1.2.4', status: 'done', trigger: 'auto', startedAt: '2026-09-20T02:03:00Z', finishedAt: '2026-09-20T02:09:12Z', error: null, step: 'verify' },
    ],
  } satisfies DemoPlatform;
  return e.platform as DemoPlatform;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const winText = (w: DemoPlatform['policy']['window']) =>
  `${w.days.map((d) => DAY[d]).join(', ')} ${String(w.startHour).padStart(2, '0')}:00–${String((w.startHour + w.hours) % 24).padStart(2, '0')}:00 UTC`;

function runView(p: DemoPlatform) {
  const r = p.run!;
  r.ticks++;
  const at = Math.min(KEYS.length, Math.floor(r.ticks / 2));
  const done = at >= KEYS.length;
  if (done && !r.finishedAt) {
    r.finishedAt = new Date().toISOString();
    p.current = '1.3.0';
    p.history.unshift({ id: r.id, fromVersion: '1.2.4', toVersion: '1.3.0', status: 'done', trigger: 'manual', startedAt: r.startedAt, finishedAt: r.finishedAt, error: null, step: 'verify' });
  }
  return {
    id: r.id,
    status: done ? 'done' : 'running',
    step: KEYS[Math.min(at, KEYS.length - 1)],
    fromVersion: '1.2.4',
    toVersion: '1.3.0',
    trigger: 'manual',
    actorId: 'u1',
    error: null,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    progress: { done: at, total: KEYS.length },
    steps: KEYS.map((key, i) => ({
      key,
      status: i < at ? 'done' : i === at ? (key === 'controller' ? 'waiting' : 'running') : 'pending',
      detail: i < at ? DETAIL[key] : i === at && key === 'engines' ? 'object storage: stop — paused ~84 s' : null,
      error: null,
      startedAt: null,
      finishedAt: null,
    })),
    log: KEYS.slice(0, at).map((k, i) => ({ at: new Date(Date.parse(r.startedAt) + i * 50_000).toISOString(), msg: `${k}: done — ${DETAIL[k]}` })),
    options: {},
  };
}

function status(s: DemoStore) {
  const p = state(s);
  const upToDate = p.current === '1.3.0';
  const run = p.run ? runView(p) : null;
  return {
    release: {
      controller: { version: p.current, commit: 'b01d53f' },
      current: { version: p.current, channel: p.policy.channel, commit: 'b01d53f', publishedAt: '2026-09-01T00:00:00Z', builtIn: false },
      available: upToDate
        ? null
        : {
            version: '1.3.0',
            channel: 'stable',
            commit: '799b2a8',
            publishedAt: '2026-09-22T00:00:00Z',
            notes: [
              { kind: 'new', text: 'Time travel: rewind any app and restore from a point' },
              { kind: 'new', text: 'Object storage on Garage v2 — faster listings, per-bucket quotas' },
              { kind: 'better', text: 'Scale-to-zero wakes in ~1.2 s (was 2.4 s)' },
              { kind: 'fix', text: 'Mesh peers behind double NAT reconnect after router reboots' },
            ],
            migrations: [{ id: 'garage-v1-to-v2', note: 'Object storage pauses for about a minute and a half while every Garage member restarts on v2; a snapshot is restored on v1 if anything fails.', pause: true }],
            verified: true,
            reason: null,
            source: 'feed',
            blocked: null,
            patch: false,
            components: [
              { key: 'controller', image: 'ghcr.io/requestflo/swarmy-controller', tag: '1.3.0', digest: `sha256:${'c'.repeat(64)}`, changed: true },
              { key: 'agent', image: 'ghcr.io/requestflo/swarmy-agent', tag: '1.3.0', digest: `sha256:${'a'.repeat(64)}`, changed: true },
              { key: 'dns', image: 'ghcr.io/requestflo/swarmy-dns', tag: '1.3.0', digest: `sha256:${'d'.repeat(64)}`, changed: true },
              { key: 'garage', image: 'docker.io/dxflrs/garage', tag: 'v2.4.1', digest: `sha256:${'9'.repeat(64)}`, changed: true },
            ],
          },
      policy: { ...p.policy, windowText: winText(p.policy.window), feed: `${p.policy.feedUrl ?? 'https://github.com/requestflo/swarmy/releases/download'}/${p.policy.channel}/platform.json` },
      lastCheckAt: new Date(Date.now() - 38 * 60_000).toISOString(),
      lastCheckError: null,
    },
    run,
    history: [...(run && run.status === 'running' ? [{ ...run, log: undefined, steps: undefined }] : []), ...p.history].map((h) => ({ ...h, actorId: null, progress: { done: 6, total: 6 }, options: {} })),
  };
}

export const platform: DomainResolvers = {
  handlers: {
    'platform.status': (_i, s) => status(s),
    'platform.check': (_i, s) => status(s).release,
    'platform.setPolicy': (i, s) => {
      const p = state(s);
      p.policy = { ...p.policy, ...(i as Partial<DemoPlatform['policy']>) };
      return p.policy;
    },
    'platform.start': (_i, s) => {
      const p = state(s);
      p.run = { id: `pr${Date.now()}`, startedAt: new Date().toISOString(), ticks: 0, finishedAt: null };
      return runView(p);
    },
    'platform.importRelease': () => ({ manifest: { version: '1.3.0' }, verified: true, source: 'bundle' }),
    'platform.retry': (_i, s) => (state(s).run ? runView(state(s)) : null),
    'platform.cancel': () => ({ status: 'cancelled' }),
    'platform.run': (_i, s) => (state(s).run ? runView(state(s)) : null),
  },
};
