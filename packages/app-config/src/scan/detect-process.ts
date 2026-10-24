/**
 * The processes the app runs: the web service and the port it listens on,
 * background workers, and scheduled work (Vercel crons, a clock process,
 * scripts named for a cadence, in-process schedulers like node-cron).
 */
import { isCron } from '../units';
import { unitNameOf } from './files';
import type { ScanCtx } from './context';
import { uniqEvidence } from './detect-data';
import type { Detection, Evidence } from './types';

/** What the build detector already knows: the framework and its default port. */
export interface FrameworkHint {
  name: string;
  port?: number;
  healthPath?: string;
  /** The dependency that gave it away (`next`), for evidence. */
  dep?: string;
}

export function detectWeb(c: ScanCtx, hint?: FrameworkHint): Detection {
  const df = c.file('Dockerfile');
  const expose = c.find('Dockerfile', /^\s*EXPOSE\s+(\d{2,5})/i);
  const envPort = c.find('Dockerfile', /^\s*ENV\s+PORT[=\s]+["']?(\d{2,5})/i);
  const procWeb = c.procfile.find((p) => p.name === 'web');
  const procPort = procWeb ? /(?:--port[=\s]|-p\s|--bind[=\s]\S*:|PORT=)(\d{2,5})/.exec(procWeb.value)?.[1] : undefined;
  const listen = c.grep(/listen\(\s*(?:[\w.]+\s*(?:\|\||\?\?)\s*)?(\d{2,5})\b/)[0];
  const fwDep = hint?.dep ? c.dep(hint.dep) : undefined;
  const picks: Array<[string | undefined, Evidence | undefined]> = [
    [expose?.value, expose?.ev],
    [envPort?.value, envPort?.ev],
    [procPort, procWeb?.ev],
    [listen?.value, listen?.ev],
    [hint?.port ? String(hint.port) : undefined, fwDep?.ev],
  ];
  const chosen = picks.find(([p, e]) => p && e);
  const port = chosen ? Number(chosen[0]) : undefined;
  const from = c.find('Dockerfile', /^\s*FROM\s+(\S+)/i);
  const manifest = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Gemfile', 'composer.json'].map((n) => c.file(n)).find((f) => f?.lines.length);
  const fallback: Evidence | undefined = manifest ? { file: manifest.path, line: manifest.lines[0]!.no, text: manifest.lines[0]!.text.trim().slice(0, 160) } : undefined;
  const found = uniqEvidence([from?.ev, chosen?.[1], procWeb?.ev, fwDep?.ev]);
  const evidence = found.length ? found : uniqEvidence([fallback]);
  const how = df ? 'built from its Dockerfile' : hint ? `built with zero-config (${hint.name})` : 'built from source';
  return {
    id: 'web',
    kind: 'web',
    name: 'web',
    maps: 'services.web',
    label: 'Web service',
    why: port ? `The app itself, ${how}, answering on port ${port}.` : `The app itself, ${how}. No port found — add one to give it an address.`,
    required: true,
    evidence: evidence.length ? evidence : [{ file: c.dir || '.', line: 1, text: 'the app folder' }],
    ...(port ? { port } : {}),
    ...(port && hint?.healthPath ? { healthPath: hint.healthPath } : {}),
  };
}

const CLOCK = /^(clock|scheduler|beat|cron)$/;

export function detectWorkers(c: ScanCtx, claim: (n: string) => string): Detection[] {
  const out: Detection[] = [];
  const worker = (raw: string, command: string, evidence: Array<Evidence | undefined>) => {
    const name = claim(unitNameOf(raw) ?? 'worker');
    out.push({
      id: `worker:${name}`,
      kind: 'worker',
      name,
      maps: `services.${name}`,
      label: 'Background worker',
      why: `Runs "${command}" from the same build, with no address — it only does work in the background.`,
      evidence: uniqEvidence(evidence),
      command,
    });
  };
  const procs = c.procfile.filter((p) => !['web', 'release'].includes(p.name) && !CLOCK.test(p.name) && !/celery\s.*\bbeat\b|\bclock\b/.test(p.value));
  for (const p of procs.slice(0, 3)) worker(p.name, p.value, [p.ev]);
  const queueCode = c.grep(/(new Worker\(|@Processor\(|\.process\()/)[0]?.ev;
  if (!out.length) {
    const s = c.scripts.find((x) => /^(start:)?workers?(:start)?$/.test(x.name));
    if (s) worker('worker', c.run(s.name), [s.ev, queueCode]);
    else if (c.dep('sidekiq')) worker('worker', 'bundle exec sidekiq', [c.dep('sidekiq')!.ev]);
  } else if (queueCode) out[0]!.evidence = uniqEvidence([...out[0]!.evidence, queueCode]);
  return out;
}

const CADENCE: Record<string, string> = { hourly: '0 * * * *', daily: '0 2 * * *', nightly: '0 2 * * *', weekly: '0 3 * * 1' };
const IN_PROCESS = ['node-cron', 'cron', 'node-schedule', 'croner', '@nestjs/schedule', 'agenda', 'apscheduler', 'rufus-scheduler', 'sidekiq-cron', 'sidekiq-scheduler', 'github.com/robfig/cron/v3'];

/** `claim` takes a service/resource name, `claimJob` a job name (jobs are their own namespace). */
export function detectCron(c: ScanCtx, claim: (n: string) => string, claimJob: (n: string) => string): Detection[] {
  const out: Detection[] = [];
  const job = (raw: string, d: Omit<Detection, 'id' | 'kind' | 'name' | 'maps'>, maps: 'jobs' | 'services') => {
    const name = (maps === 'jobs' ? claimJob : claim)(unitNameOf(raw) ?? 'job');
    out.push({ id: `cron:${name}`, kind: 'cron', name, maps: `${maps}.${name}`, ...d });
  };
  // Vercel crons: an HTTP path on a schedule.
  const vercel = c.file('vercel.json');
  if (vercel) {
    const lines = vercel.lines;
    for (let i = 0; i < lines.length && out.length < 5; i++) {
      const p = /"path"\s*:\s*"(\/[^"]*)"/.exec(lines[i]!.text);
      if (!p) continue;
      const near = lines.slice(Math.max(0, i - 2), i + 3).map((l) => /"schedule"\s*:\s*"([^"]+)"/.exec(l.text)?.[1]).find(Boolean);
      if (!near || !isCron(near)) continue;
      const ev = { file: vercel.path, line: lines[i]!.no, text: lines[i]!.text.trim() };
      job(p[1]!.split('/').filter(Boolean).pop() ?? 'cron', { label: 'Scheduled request', why: `Calls ${p[1]} on the web service at "${near}", as Vercel did.`, evidence: [ev], via: 'http', schedule: near, path: p[1]! }, 'jobs');
    }
  }
  // A clock process (Heroku-style) runs its own schedule; it becomes a one-copy service.
  for (const p of c.procfile.filter((x) => CLOCK.test(x.name) || /celery\s.*\bbeat\b/.test(x.value)).slice(0, 1)) {
    job(p.name, { label: 'Clock process', why: `Runs "${p.value}" as one always-on copy, so each schedule fires once.`, evidence: [p.ev], via: 'clock', command: p.value }, 'services');
  }
  // Scripts named for a cadence: `invoices:nightly`, `cron:hourly`.
  for (const s of c.scripts) {
    const cadence = /(?:^|[:_-])(hourly|daily|nightly|weekly)(?:[:_-]|$)/.exec(s.name)?.[1];
    if (!cadence || out.length >= 5) continue;
    const base = s.name.replace(/(?:^|[:_-])(hourly|daily|nightly|weekly|cron)(?=[:_-]|$)/g, '').replace(/^[:_-]+|[:_-]+$/g, '') || cadence;
    job(base, { label: 'Scheduled script', why: `Runs ${c.run(s.name)} at "${CADENCE[cadence]}" (${cadence}) — change the time in jobs:.`, evidence: [s.ev], via: 'script', schedule: CADENCE[cadence]!, command: c.run(s.name) }, 'jobs');
  }
  // In-process schedulers fire once per copy of the process that loads them
  // (the web service, unless the code says otherwise): keep it at one copy.
  const lib = c.dep(...IN_PROCESS);
  if (lib) {
    const call = c.grep(/(?:schedule|scheduleJob|CronJob|Cron)\(\s*['"]([^'"]+)['"]/).find((h) => isCron(h.value));
    const host = 'web';
    out.push({
      id: 'cron:in-process',
      kind: 'cron',
      name: host,
      maps: `services.${host}.replicas`,
      label: `In-app schedule (${lib.name})`,
      why: `${lib.name} runs inside ${host}${call ? ` ("${call.value}")` : ''}, so every copy fires it — swarmy keeps ${host} at one copy.`,
      evidence: uniqEvidence([lib.ev, call?.ev]),
      via: 'in-process',
      host,
      ...(call ? { schedule: call.value } : {}),
    });
  }
  return out;
}
