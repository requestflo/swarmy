/**
 * Scheduled work: Vercel crons, a clock process (Procfile `clock`, celery
 * beat in the Procfile, compose or the code's beat_schedule), scripts named
 * for a cadence, whenever's schedule.rb, a `cron` / `*.schedule` label on a
 * compose service, and in-process schedulers like node-cron. Each says why.
 */
import { isCron } from '../units';
import type { ScanCtx } from './context';
import { CLOCK } from './detect-process';
import { unitNameOf } from './files';
import { relTo, uniqEvidence } from './signals';
import type { Detection, Evidence } from './types';
import { wheneverJobs } from './whenever';

const CADENCE: Record<string, string> = { hourly: '0 * * * *', daily: '0 2 * * *', nightly: '0 2 * * *', weekly: '0 3 * * 1' };
const IN_PROCESS = ['node-cron', 'cron', 'node-schedule', 'croner', '@nestjs/schedule', 'agenda', 'apscheduler', 'rufus-scheduler', 'sidekiq-cron', 'sidekiq-scheduler', 'github.com/robfig/cron/v3'];
const BEAT = /celery\s.*\bbeat\b/;
const CRON_LABEL = /(^|[.-])(cron|schedule)$/i;

type JobFields = Omit<Detection, 'id' | 'kind' | 'name' | 'maps' | 'reason'>;

/** `claim` takes a service/resource name, `claimJob` a job name (jobs are their own namespace). */
export function detectCron(c: ScanCtx, claim: (n: string) => string, claimJob: (n: string) => string): Detection[] {
  const out: Detection[] = [];
  const at = (e: Evidence): string => relTo(c.dir, e.file);
  const job = (raw: string, says: string, d: JobFields, maps: 'jobs' | 'services') => {
    const name = (maps === 'jobs' ? claimJob : claim)(unitNameOf(raw) ?? 'job');
    out.push({ id: `cron:${name}`, kind: 'cron', name, maps: `${maps}.${name}`, reason: `${says} in ${at(d.evidence[0]!)}`, ...d });
  };
  // Vercel crons: an HTTP path on a schedule.
  const vercel = c.file('vercel.json');
  const lines = vercel?.lines ?? [];
  for (let i = 0; vercel && i < lines.length && out.length < 5; i++) {
    const p = /"path"\s*:\s*"(\/[^"]*)"/.exec(lines[i]!.text);
    if (!p) continue;
    const near = lines.slice(Math.max(0, i - 2), i + 3).map((l) => /"schedule"\s*:\s*"([^"]+)"/.exec(l.text)?.[1]).find(Boolean);
    if (!near || !isCron(near)) continue;
    const ev = { file: vercel.path, line: lines[i]!.no, text: lines[i]!.text.trim() };
    job(p[1]!.split('/').filter(Boolean).pop() ?? 'cron', `calls ${p[1]} on a Vercel cron`, { label: 'Scheduled request', why: `Calls ${p[1]} on the web service at "${near}", as Vercel did.`, evidence: [ev], via: 'http', schedule: near, path: p[1]! }, 'jobs');
  }
  // A clock process (Heroku-style, celery beat) runs its own schedule; it becomes a one-copy service.
  const clock = c.procfile.find((x) => CLOCK.test(x.name) || BEAT.test(x.value));
  const beat = clock ? undefined : c.compose.find((s) => s.command && BEAT.test(s.command.value));
  const beatCode = clock || beat ? undefined : c.grep(/(beat_schedule|CELERY_BEAT_SCHEDULE)\b/)[0];
  const celeryWorker = beatCode ? [...c.procfile, ...c.compose.flatMap((s) => (s.command ? [s.command] : []))].find((x) => /celery\s.*\bworker\b/.test(x.value)) : undefined;
  const clockCmd = clock?.value ?? beat?.command?.value ?? celeryWorker?.value.replace(/\bworker\b/, 'beat').replace(/\s--?(c|concurrency|Q|queues|autoscale|pool)[=\s]\S+/g, '');
  const clockEv = clock?.ev ?? beat?.command?.ev ?? beatCode?.ev;
  if (clockCmd && clockEv) {
    const says = clock ? `runs a ${clock.name} process` : beat ? `runs celery beat as ${beat.name}` : 'defines a celery beat schedule';
    const evidence = uniqEvidence([clockEv, celeryWorker?.ev]);
    job(clock?.name ?? (beat ? beat.name : 'beat'), says, { label: 'Clock process', why: `Runs "${clockCmd}" as one always-on copy, so each schedule fires once.`, evidence, via: 'clock', command: clockCmd }, 'services');
  }
  // Scripts named for a cadence: `invoices:nightly`, `cron:hourly`.
  for (const s of c.scripts) {
    const cadence = /(?:^|[:_-])(hourly|daily|nightly|weekly)(?:[:_-]|$)/.exec(s.name)?.[1];
    if (!cadence || out.length >= 5) continue;
    const base = s.name.replace(/(?:^|[:_-])(hourly|daily|nightly|weekly|cron)(?=[:_-]|$)/g, '').replace(/^[:_-]+|[:_-]+$/g, '') || cadence;
    job(base, `has the script ${s.name}`, { label: 'Scheduled script', why: `Runs ${c.run(s.name)} at "${CADENCE[cadence]}" (${cadence}) — change the time in jobs:.`, evidence: [s.ev], via: 'script', schedule: CADENCE[cadence]!, command: c.run(s.name) }, 'jobs');
  }
  // whenever: every block of config/schedule.rb that reads as a schedule + a command.
  const schedule = c.dep('whenever') ? c.file('config/schedule.rb') : undefined;
  for (const w of schedule ? wheneverJobs(schedule) : []) {
    if (out.length >= 5) break;
    const ev = { file: schedule!.path, line: w.line.no, text: w.line.text.trim().slice(0, 160) };
    job(w.hint, 'schedules it with whenever', { label: 'Scheduled task (whenever)', why: `Runs ${w.command} at "${w.schedule}", as whenever did — change the time in jobs:.`, evidence: uniqEvidence([ev, c.dep('whenever')?.ev]), via: 'script', schedule: w.schedule, command: w.command }, 'jobs');
  }
  // A compose service with a cron label (`cron`, `swarm.cronjob.schedule`, `ofelia.job-run.x.schedule`).
  for (const s of c.compose) {
    const label = s.labels.find((l) => CRON_LABEL.test(l.name) && isCron(l.value));
    if (!label || out.length >= 5) continue;
    const prefix = label.name.replace(/\.?schedule$/i, '');
    const command = (prefix ? s.labels.find((l) => l.name === `${prefix}.command`)?.value : undefined) ?? s.command?.value;
    if (!command) continue;
    const image = s.build ? undefined : s.image?.value;
    job(s.name, `labels ${s.name} ${label.name}: "${label.value}"`, { label: 'Scheduled container', why: `Runs "${command}" at "${label.value}"${image ? ` in ${image}` : ''}, as the compose label did.`, evidence: uniqEvidence([label.ev, s.command?.ev]), via: 'script', schedule: label.value, command, ...(image ? { image } : {}) }, 'jobs');
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
      reason: call ? `schedules "${call.value}" with ${lib.name} in ${at(call.ev)}` : `uses ${lib.name} in ${at(lib.ev)}`,
      evidence: uniqEvidence([lib.ev, call?.ev]),
      via: 'in-process',
      host,
      ...(call ? { schedule: call.value } : {}),
    });
  }
  return out;
}
