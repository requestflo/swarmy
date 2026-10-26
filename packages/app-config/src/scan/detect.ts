/**
 * `detectAppNeeds` — what an app in `dir` needs, from the files a scan read.
 * Pure and shared: the controller runs it over git.inspect's probes and grep
 * hits, `swarmy check` over the local disk, MCP `check_repo` over the files
 * it was sent — same detections, same evidence.
 */
import { buildCtx } from './context';
import { detectBucket } from './detect-bucket';
import { detectCron } from './detect-cron';
import { detectCache, detectPostgres } from './detect-data';
import { detectWeb, detectWorkers, type FrameworkHint } from './detect-process';
import { at } from './files';
import type { BuildFacts, Detection, ScanFile, ScanResult } from './types';

export interface DetectOptions {
  /** The app's folder, repo-relative ('' = the root). */
  dir?: string;
  /** Files known to exist without being read (lockfiles, manage.py). */
  present?: readonly string[];
  /** The framework the build detector recognised (its default port and health path). */
  framework?: FrameworkHint;
}

/** Stages and ARGs of the folder's Dockerfile. */
export function dockerfileFacts(files: ScanFile[], dir = ''): BuildFacts {
  const path = at(dir, 'Dockerfile');
  const df = files.find((f) => f.path === path);
  if (!df) return { stages: [], args: [] };
  const stages: string[] = [];
  const args: BuildFacts['args'] = [];
  for (const l of df.lines) {
    const from = /^\s*FROM\s+\S+(?:\s+AS\s+([A-Za-z0-9_.-]+))?/i.exec(l.text);
    if (from?.[1]) stages.push(from[1]);
    const arg = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i.exec(l.text);
    if (arg && !args.some((a) => a.name === arg[1])) args.push({ name: arg[1]!, ...(arg[2] !== undefined ? { default: arg[2].trim().replace(/^(['"])(.*)\1$/, '$2') } : {}) });
  }
  return { dockerfile: path, stages, args };
}

export function detectAppNeeds(files: ScanFile[], opts: DetectOptions = {}): ScanResult {
  const dir = (opts.dir ?? '').replace(/^\.?\/*|\/+$/g, '');
  const c = buildCtx(files, dir, opts.present);
  const taken = new Set<string>(['web']);
  const claimIn = (set: Set<string>) => (n: string): string => {
    let name = n;
    for (let i = 2; set.has(name); i++) name = `${n.slice(0, 27)}-${i}`;
    set.add(name);
    return name;
  };
  const claim = claimIn(taken);
  const data = [detectPostgres(c), detectCache(c)].filter((d): d is Detection => d !== null);
  for (const d of data) taken.add(d.name);
  const bucket = detectBucket(c, taken);
  if (bucket) taken.add(bucket.name);
  const workers = detectWorkers(c, claim);
  const crons = detectCron(c, claim, claimIn(new Set()));
  const detections = [detectWeb(c, opts.framework), ...workers, ...data, ...(bucket ? [bucket] : []), ...crons];
  return {
    detections,
    files: new Set(files.map((f) => f.path)).size,
    build: dockerfileFacts(files, dir),
  };
}
