import type { DemoStore, DomainResolvers } from '../types';
import { demoRunView, newDemoRun, runControls, type RunHost } from './platform-run';
import { bundleResolvers } from './platform-bundle';

/**
 * Settings → Platform demo: v1.2.4 on Stable with v1.3.0 ready (signed,
 * verified, a Garage major inside). "Start upgrade" plays the run through its
 * steps on each poll; "Pause after this step", Resume and Abandon work on it
 * (platform-run.ts). Mirrors PlatformStatusView (platform-upgrade.service.ts).
 */
interface DemoPlatform extends RunHost {
  policy: { channel: 'stable' | 'edge'; feedUrl: string | null; autoApplyPatches: boolean; window: { days: number[]; startHour: number; hours: number } };
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

const ACTIVE = new Set(['running', 'paused', 'abandoning']);
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const winText = (w: DemoPlatform['policy']['window']) =>
  `${w.days.map((d) => DAY[d]).join(', ')} ${String(w.startHour).padStart(2, '0')}:00–${String((w.startHour + w.hours) % 24).padStart(2, '0')}:00 UTC`;

function status(s: DemoStore) {
  const p = state(s);
  // The run first: finishing it moves `current`, so the same poll already reads up to date.
  const run = p.run ? demoRunView(p) : null;
  const upToDate = p.current === '1.3.0';
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
              { key: 'controller', image: 'ghcr.io/requestflo/swarmy-controller', tag: '1.3.0', digest: `sha256:${'c'.repeat(64)}`, fromTag: '1.2.4', fromDigest: null, changed: true },
              { key: 'agent', image: 'ghcr.io/requestflo/swarmy-agent', tag: '1.3.0', digest: `sha256:${'a'.repeat(64)}`, fromTag: '1.2.4', fromDigest: null, changed: true },
              { key: 'dns', image: 'ghcr.io/requestflo/swarmy-dns', tag: '1.3.0', digest: `sha256:${'d'.repeat(64)}`, fromTag: '1.2.4', fromDigest: null, changed: true },
              { key: 'garage', image: 'docker.io/dxflrs/garage', tag: 'v2.4.1', digest: `sha256:${'9'.repeat(64)}`, fromTag: 'v1.0.1', fromDigest: null, changed: true },
            ],
          },
      policy: { ...p.policy, windowText: winText(p.policy.window), feed: `${p.policy.feedUrl ?? 'https://github.com/requestflo/swarmy/releases/download'}/${p.policy.channel}/platform.json` },
      lastCheckAt: new Date(demoCheckedAt).toISOString(),
      lastCheckError: null,
    },
    run,
    history: [...(run && ACTIVE.has(run.status) ? [{ ...run, log: undefined, steps: undefined, abandon: undefined }] : []), ...p.history].map((h) => ({
      pause: null,
      ...h,
      actorId: null,
      progress: { done: 6, total: 6 },
      options: {},
    })),
  };
}

/** When the demo last "checked the feed": 38 min before load, then whenever Check runs. */
let demoCheckedAt = Date.now() - 38 * 60_000;

export const platform: DomainResolvers = {
  handlers: {
    'platform.status': (_i, s) => status(s),
    'platform.check': (_i, s) => {
      demoCheckedAt = Date.now();
      return status(s).release;
    },
    'platform.setPolicy': (i, s) => {
      const p = state(s);
      p.policy = { ...p.policy, ...(i as Partial<DemoPlatform['policy']>) };
      return p.policy;
    },
    'platform.start': (_i, s) => {
      const p = state(s);
      p.run = newDemoRun();
      return demoRunView(p);
    },
    'platform.importRelease': () => ({ manifest: { version: '1.3.0' }, verified: true, source: 'bundle' }),
    ...bundleResolvers,
    'platform.retry': (_i, s) => (state(s).run ? demoRunView(state(s)) : null),
    'platform.cancel': () => ({ status: 'cancelled' }),
    'platform.run': (_i, s) => (state(s).run ? demoRunView(state(s)) : null),
    'platform.pause': (i, s) => runControls.pause(state(s), i as { pause?: boolean }),
    'platform.resume': (_i, s) => runControls.resume(state(s)),
    'platform.abandon': (_i, s) => runControls.abandon(state(s)),
  },
};
