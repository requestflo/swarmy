/**
 * The demo's platform upgrade run, replayed on the clock (each step STEP_MS),
 * with "Pause after this step", Resume and Abandon. Mirrors PlatformRunView
 * (platform-upgrade.service.ts) and the pause rules in platform-upgrade.pause.ts:
 * a pause lands once the current step finishes (never after the last one);
 * Abandon puts back system services, then agents; the controller and object
 * storage stay.
 */
const KEYS = ['preflight', 'controller', 'agents', 'system', 'engines', 'verify'] as const;
const STEP_MS = 6_000;
const BACK_MS = 4_000;
const DETAIL: Record<string, string> = {
  preflight: '4 server(s) online, quorum ok, backup taken',
  controller: 'the new controller is up and resumed the run',
  agents: '4 agent(s) upgraded, one at a time',
  system: '3 system service(s) upgraded',
  engines: 'object storage on dxflrs/garage:v2.4.1',
  verify: '4 server(s) online, system services converged',
};
const BACKING: Record<string, string> = {
  system: 'swarmy-dns: back to ghcr.io/requestflo/swarmy-dns@sha256:…',
  agents: '4 container agent(s) going back to 1.2.4',
};
const KEPT: Record<string, string> = {
  controller: 'the controller stays on the new build: its database already moved forward (the preflight backup is the way back)',
  engines: 'object storage stays on the new version: a Garage major moves its data forward',
};

export interface DemoRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  /** Time spent paused, applied to steps from `fromIdx` on. */
  shifts: Array<{ fromIdx: number; ms: number }>;
  /** Index of the step that was running when "Pause after this step" was pressed. */
  pauseAt: number | null;
  pauseAskedAt: string | null;
  paused: { idx: number; since: number } | null;
  abandon: { since: number } | null;
}

export interface RunHost {
  current: string;
  run: DemoRun | null;
  history: Array<{ id: string; fromVersion: string; toVersion: string; status: string; trigger: string; startedAt: string; finishedAt: string | null; error: string | null; step: string }>;
}

export function newDemoRun(): DemoRun {
  return { id: `pr${Date.now()}`, startedAt: new Date().toISOString(), finishedAt: null, shifts: [], pauseAt: null, pauseAskedAt: null, paused: null, abandon: null };
}

const iso = (ms: number) => new Date(ms).toISOString();

export function demoRunView(p: RunHost, now = Date.now()) {
  const r = p.run!;
  const t0 = Date.parse(r.startedAt);
  const shiftUpTo = (i: number) => r.shifts.filter((s) => s.fromIdx <= i).reduce((a, s) => a + s.ms, 0);
  const startOf = (i: number) => t0 + i * STEP_MS + shiftUpTo(i);
  const endOf = (i: number) => t0 + (i + 1) * STEP_MS + shiftUpTo(i);
  const raw = Math.floor((now - t0 - shiftUpTo(KEYS.length)) / STEP_MS);
  // A pause lands once the step it was asked on finishes (never after the last one).
  if (!r.paused && r.pauseAt !== null && raw > r.pauseAt && r.pauseAt < KEYS.length - 1) r.paused = { idx: r.pauseAt + 1, since: endOf(r.pauseAt) };
  const at = r.paused ? r.paused.idx : Math.min(KEYS.length, raw);
  const putBack = (['system', 'agents'] as const).filter((k) => KEYS.indexOf(k) < at);
  const backDone = r.abandon ? Math.min(putBack.length, Math.floor((now - r.abandon.since) / BACK_MS)) : 0;
  const status = r.abandon ? (backDone >= putBack.length ? 'abandoned' : 'abandoning') : r.paused ? 'paused' : at >= KEYS.length ? 'done' : 'running';
  if ((status === 'done' || status === 'abandoned') && !r.finishedAt) {
    r.finishedAt = iso(status === 'done' ? endOf(KEYS.length - 1) : r.abandon!.since + putBack.length * BACK_MS);
    if (status === 'done') p.current = '1.3.0';
    p.history.unshift({ id: r.id, fromVersion: '1.2.4', toVersion: '1.3.0', status, trigger: 'manual', startedAt: r.startedAt, finishedAt: r.finishedAt, error: null, step: status === 'done' ? 'verify' : 'agents' });
  }
  const back = new Set(putBack.slice(0, backDone));
  const backing = status === 'abandoning' ? putBack[backDone] : undefined;
  const kept = (['engines', 'controller'] as const).filter((k) => KEYS.indexOf(k) < at).map((key) => ({ key, why: KEPT[key]! }));
  const log = KEYS.slice(0, at).map((k, i) => ({ at: iso(endOf(i)), msg: `${k}: done — ${DETAIL[k]}` }));
  if (r.paused) log.push({ at: iso(r.paused.since), msg: `paused after ${KEYS[r.paused.idx - 1]}, as asked — ${KEYS[r.paused.idx]} is next` });
  for (const k of back) log.push({ at: iso(r.abandon!.since + (putBack.indexOf(k) + 1) * BACK_MS), msg: `${k} put back` });
  return {
    id: r.id,
    status,
    step: backing ?? (status === 'abandoned' ? putBack.at(-1) ?? KEYS[at] : KEYS[Math.min(at, KEYS.length - 1)]),
    fromVersion: '1.2.4',
    toVersion: '1.3.0',
    trigger: 'manual',
    actorId: 'u1',
    error: null,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    progress: { done: Math.min(at, KEYS.length), total: KEYS.length },
    steps: KEYS.map((key, i) => ({
      key,
      status: back.has(key as never) ? 'rolled-back' : i < at ? 'done' : i === at && status === 'running' ? (key === 'controller' ? 'waiting' : 'running') : 'pending',
      detail: key === backing ? BACKING[key] : i < at ? DETAIL[key] : i === at && key === 'engines' && status === 'running' ? 'object storage: stop — paused ~84 s' : null,
      error: null,
      startedAt: i < at || (i === at && status === 'running') ? iso(startOf(i)) : null,
      finishedAt: i < at ? iso(endOf(i)) : null,
    })),
    log,
    options: {},
    pause: status === 'running' && r.pauseAt !== null ? { requestedAt: r.pauseAskedAt!, by: 'u1' } : null,
    abandon: status === 'paused' ? { putBack: [...putBack], kept } : null,
  };
}

/** "Pause after this step" (pause: false takes it back), Resume and Abandon on the demo run. */
export const runControls = {
  pause: (p: RunHost, i: { pause?: boolean }) => {
    const r = p.run!;
    const v = demoRunView(p);
    r.pauseAt = i.pause === false ? null : v.progress.done;
    r.pauseAskedAt = r.pauseAt === null ? null : new Date().toISOString();
    return demoRunView(p);
  },
  resume: (p: RunHost) => {
    const r = p.run!;
    if (r.paused) r.shifts.push({ fromIdx: r.paused.idx, ms: Date.now() - r.paused.since });
    r.paused = null;
    r.pauseAt = null;
    return demoRunView(p);
  },
  abandon: (p: RunHost) => {
    p.run!.abandon = { since: Date.now() };
    return demoRunView(p);
  },
};
