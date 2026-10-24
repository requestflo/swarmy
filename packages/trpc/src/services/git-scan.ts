/**
 * The New app wizard's "Here's what we found" (board 24) — PURE.
 *
 * `scanFromInspect` turns a git.inspect read (probes + source grep) into the
 * shared `@swarmy/app-config` detections; `draftConfig` turns the ticked ones
 * into a swarmy.yaml, re-parses it with the controller's own parser ("valid ·
 * v1" is the parser's word, not ours) and draws the app `toDesired` would
 * create. Nothing here deploys or writes to git.
 */
import {
  SCAN_FILES,
  SCAN_PRESENCE_FILES,
  detectAppNeeds,
  generateAppConfig,
  parseAppConfig,
  scanFile,
  scanHits,
  suggestAppName,
  toDesired,
  type BuildFacts,
  type BuildOptions,
  type DesiredApp,
  type Detection,
  type ScanFile,
} from '@swarmy/app-config';
import { frameworkDep, type BuildDetection } from './git-providers/detect-build';
import type { InspectResult } from './git-providers/inspect';

export interface AppScanView {
  /** The app's folder ('' = the repo root). */
  dir: string;
  /** A suggested `app:` name (the folder, else the repo). */
  app: string;
  /** Files the scan read: manifests, plus every source file it grepped. */
  files: number;
  /** How long the read took on the builder, ms. */
  ms: number;
  detections: Detection[];
  build: BuildFacts;
}

const at = (dir: string, f: string): string => (dir ? `${dir}/${f}` : f);

/** Extra git.inspect probes the scan reads in `dir`. */
export function scanProbePaths(dir: string): { probePaths: string[]; presencePaths: string[] } {
  return { probePaths: SCAN_FILES.map((f) => at(dir, f)), presencePaths: SCAN_PRESENCE_FILES.map((f) => at(dir, f)) };
}

export function scanFromInspect(
  res: InspectResult,
  opts: { dir: string; repo: string; detected: BuildDetection; ms: number },
): AppScanView {
  const files: ScanFile[] = [];
  const present: string[] = [];
  for (const [p, text] of Object.entries(res.probes ?? {})) {
    if (text === '') present.push(p);
    else files.push(scanFile(p, text));
  }
  for (const [p, text] of Object.entries(res.files)) if (text) files.push(scanFile(p, text));
  for (const f of res.scan?.files ?? []) {
    files.push(scanHits(f, (res.scan?.hits ?? []).filter((h) => h.file === f)));
  }
  const d = opts.detected;
  const dep = frameworkDep(d.framework);
  const found = detectAppNeeds(files, {
    dir: opts.dir,
    present,
    ...(!d.unknown && d.builder === 'railpack'
      ? { framework: { name: d.framework ?? d.language ?? 'zero-config', ...(d.port ? { port: d.port } : {}), ...(d.healthPath ? { healthPath: d.healthPath } : {}), ...(dep ? { dep } : {}) } }
      : {}),
  });
  return { dir: opts.dir, app: suggestAppName(opts.dir || opts.repo), files: found.files, ms: opts.ms, detections: found.detections, build: found.build };
}

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

function graphOf(d: DesiredApp): AppGraphView {
  return {
    stack: d.stack,
    services: d.services.map((s) => ({
      name: s.name,
      meta: [s.source.kind === 'build' ? `built from ${s.source.context}` : s.source.image, s.port ? `:${s.port}` : 'no address', `${s.replicas} cop${s.replicas === 1 ? 'y' : 'ies'}`].join(' · '),
      wires: s.dependsOn,
    })),
    data: d.resources.map((r) => ({
      name: r.name,
      meta:
        r.type === 'postgres'
          ? `postgres ${r.version} · ${r.ha === 'single' ? 'one server' : r.ha} · ${r.backups ? `backed up ${r.backups.schedule}, kept ${r.backups.keep}` : 'no backups'}`
          : r.type === 'cache'
            ? `${r.engine}${r.purpose === 'queue' ? ' queue' : ''} · ${r.memoryMb} MB`
            : r.type === 'bucket'
              ? `bucket · ${r.access}`
              : `${r.type} · ${r.engine}`,
    })),
    jobs: d.jobs.map((j) => ({ name: j.name, meta: `${j.schedule} · in ${j.service ?? j.image ?? 'its image'}` })),
  };
}

export function draftConfig(input: { app: string; dir: string; detections: Detection[]; selected: string[]; build?: BuildOptions }): DraftView {
  const out = generateAppConfig(input.detections, { app: input.app, dir: input.dir, selected: input.selected, ...(input.build ? { build: input.build } : {}) });
  const parsed = parseAppConfig(out.yaml);
  let graph: AppGraphView | null = null;
  if (parsed.config) {
    try {
      graph = graphOf(toDesired(parsed.config));
    } catch {
      graph = null;
    }
  }
  return {
    yaml: out.yaml,
    valid: Boolean(parsed.config),
    issues: parsed.issues.map((i) => ({ severity: i.severity, message: i.message, ...(i.line ? { line: i.line } : {}) })),
    notes: out.notes,
    graph,
  };
}
