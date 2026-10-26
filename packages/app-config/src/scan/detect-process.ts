/**
 * The processes the app runs: the web service and the port it listens on,
 * and background workers. Scheduled work is detect-cron.ts.
 */
import { unitNameOf } from './files';
import type { ScanCtx } from './context';
import { relTo, uniqEvidence } from './signals';
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
  const found = uniqEvidence([chosen?.[1], from?.ev, procWeb?.ev, fwDep?.ev]);
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

/** Procfile names of a process that runs its own schedule (detect-cron.ts makes it a clock). */
export const CLOCK = /^(clock|scheduler|beat|cron)$/;

export function detectWorkers(c: ScanCtx, claim: (n: string) => string): Detection[] {
  const out: Detection[] = [];
  const worker = (raw: string, command: string, says: string, evidence: Array<Evidence | undefined>) => {
    const name = claim(unitNameOf(raw) ?? 'worker');
    const first = evidence.find(Boolean);
    out.push({
      id: `worker:${name}`,
      kind: 'worker',
      name,
      maps: `services.${name}`,
      label: 'Background worker',
      why: `Runs "${command}" from the same build, with no address — it only does work in the background.`,
      ...(first ? { reason: `${says} in ${relTo(c.dir, first.file)}` } : {}),
      evidence: uniqEvidence(evidence),
      command,
    });
  };
  const procs = c.procfile.filter((p) => !['web', 'release'].includes(p.name) && !CLOCK.test(p.name) && !/celery\s.*\bbeat\b|\bclock\b/.test(p.value));
  for (const p of procs.slice(0, 3)) worker(p.name, p.value, `runs a ${p.name} process`, [p.ev]);
  const queueCode = c.grep(/(new Worker\(|@Processor\(|\.process\()/)[0]?.ev;
  if (!out.length) {
    const s = c.scripts.find((x) => /^(start:)?workers?(:start)?$/.test(x.name));
    if (s) worker('worker', c.run(s.name), `has the script ${s.name}`, [s.ev, queueCode]);
    else if (c.dep('sidekiq')) worker('worker', 'bundle exec sidekiq', 'runs Sidekiq workers', [c.dep('sidekiq')!.ev]);
  } else if (queueCode) out[0]!.evidence = uniqEvidence([...out[0]!.evidence, queueCode]);
  return out;
}
