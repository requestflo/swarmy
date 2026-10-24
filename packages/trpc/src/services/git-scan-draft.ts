/**
 * A swarmy.yaml draft as the New app wizard shows it (board 24) — PURE: the
 * text, the controller parser's verdict ("valid · v1" is the parser's word,
 * not ours) and the app `toDesired` would create. Shared by the generated
 * draft (`draftConfig`) and the Heroku import (`git-scan-heroku.ts`).
 */
import { parseAppConfig, toDesired, type DesiredApp } from '@swarmy/app-config';

export interface AppGraphView {
  stack: string;
  services: Array<{ name: string; meta: string; wires: string[] }>;
  data: Array<{ name: string; meta: string }>;
  jobs: Array<{ name: string; meta: string }>;
}

export interface DraftView {
  yaml: string;
  /** The controller's parser found no errors. */
  valid: boolean;
  issues: Array<{ severity: 'error' | 'warning'; message: string; line?: number }>;
  /** Ticked things the file couldn't express, in plain words. */
  notes: string[];
  /** What `toDesired` would create (empty when invalid). */
  graph: AppGraphView | null;
}

export function graphOf(d: DesiredApp): AppGraphView {
  return {
    stack: d.stack,
    services: d.services.map((s) => ({
      name: s.name,
      meta: [s.source.kind === 'build' ? 'build' : s.source.image, s.port ? `:${s.port}` : 'no address', `${s.replicas} cop${s.replicas === 1 ? 'y' : 'ies'}`].join(' · '),
      wires: s.dependsOn,
    })),
    data: d.resources.map((r) => ({
      name: r.name,
      meta:
        r.type === 'postgres'
          ? [`postgres ${r.version}`, r.ha === 'single' ? null : r.ha, r.backups ? `backed up ${r.backups.schedule}` : 'no backups'].filter(Boolean).join(' · ')
          : r.type === 'cache'
            ? `${r.engine}${r.purpose === 'queue' ? ' queue' : ''} · ${r.memoryMb} MB`
            : r.type === 'bucket'
              ? `bucket · ${r.access}`
              : `${r.type} · ${r.engine}`,
    })),
    jobs: d.jobs.map((j) => ({ name: j.name, meta: `${j.schedule} · in ${j.service ?? j.image ?? 'its image'}` })),
  };
}

/** Parse the text with the controller's parser and draw the app it makes. */
export function toDraftView(yaml: string, notes: string[]): DraftView {
  const parsed = parseAppConfig(yaml);
  let graph: AppGraphView | null = null;
  if (parsed.config) {
    try {
      graph = graphOf(toDesired(parsed.config));
    } catch {
      graph = null;
    }
  }
  return {
    yaml,
    valid: Boolean(parsed.config),
    issues: parsed.issues.map((i) => ({ severity: i.severity, message: i.message, ...(i.line ? { line: i.line } : {}) })),
    notes,
    graph,
  };
}
