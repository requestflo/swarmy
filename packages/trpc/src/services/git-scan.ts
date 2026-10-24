/**
 * The New app wizard's "Here's what we found" (board 24) — PURE.
 *
 * `scanFromInspect` turns a git.inspect read (probes + source grep) into the
 * shared `@swarmy/app-config` detections — and, for a folder with a Procfile
 * beside a Heroku app.json, the Heroku import (`git-scan-heroku.ts`).
 * `draftConfig` turns the ticked detections into a swarmy.yaml, re-parses it
 * with the controller's own parser and draws the app `toDesired` would
 * create (`git-scan-draft.ts`). Nothing here deploys or writes to git.
 */
import {
  SCAN_FILES,
  SCAN_PRESENCE_FILES,
  detectAppNeeds,
  generateAppConfig,
  scanFile,
  scanHits,
  suggestAppName,
  type BuildFacts,
  type BuildOptions,
  type Detection,
  type ScanFile,
} from '@swarmy/app-config';
import { frameworkDep, type BuildDetection } from './git-providers/detect-build';
import type { InspectResult } from './git-providers/inspect';
import { toDraftView, type DraftView } from './git-scan-draft';
import { herokuScanView, type HerokuScanView } from './git-scan-heroku';

export type { AppGraphView, DraftView } from './git-scan-draft';
export type { HerokuScanView } from './git-scan-heroku';

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
  /** "Looks like a Heroku app": the import, its draft and the steps for data + config. */
  heroku?: HerokuScanView;
}

const at = (dir: string, f: string): string => (dir ? `${dir}/${f}` : f);

/** Extra git.inspect probes the scan reads in `dir`. */
export function scanProbePaths(dir: string): { probePaths: string[]; presencePaths: string[] } {
  return { probePaths: SCAN_FILES.map((f) => at(dir, f)), presencePaths: SCAN_PRESENCE_FILES.map((f) => at(dir, f)) };
}

/** Files the scan reads WHOLE (a probe stops at 4 KB): app.json, which the Heroku import parses as JSON. */
export function scanReadPaths(dir: string): string[] {
  return [at(dir, 'app.json')];
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
  // Whole files after probes: the later copy of a path wins.
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
  const app = suggestAppName(opts.dir || opts.repo);
  const heroku = herokuScanView(files, opts.dir, app);
  return { dir: opts.dir, app, files: found.files, ms: opts.ms, detections: found.detections, build: found.build, ...(heroku ? { heroku } : {}) };
}

export function draftConfig(input: { app: string; dir: string; detections: Detection[]; selected: string[]; build?: BuildOptions }): DraftView {
  const out = generateAppConfig(input.detections, { app: input.app, dir: input.dir, selected: input.selected, ...(input.build ? { build: input.build } : {}) });
  return toDraftView(out.yaml, out.notes);
}
