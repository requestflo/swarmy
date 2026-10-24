/**
 * "What does this app need?" for `swarmy check` and MCP `check_repo`: read
 * the same manifests and source lines the controller's git.inspect reads,
 * then run the shared `@swarmy/app-config` detectors over them — so the CLI,
 * MCP and the New app wizard report the same detections with the same
 * file:line evidence.
 */
import {
  SCAN_FILES,
  SCAN_PRESENCE_FILES,
  SOURCE_SCAN_MAX_FILES,
  SOURCE_SCAN_MAX_HITS,
  SOURCE_SCAN_MAX_HITS_PER_FILE,
  SOURCE_SCAN_PATTERN,
  detectAppNeeds,
  isSourcePath,
  scanFile,
  scanHits,
  type ScanFile,
  type ScanResult,
} from '@swarmy/app-config';
import { describeDetection, frameworkDep, type StackDetection } from './detect';
import { joinRel, type RepoFs } from './fs';

const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'coverage', '.next', 'test', 'tests', '__tests__', 'spec', 'fixtures', 'migrations']);
const MAX_DIRS = 200;

/** Source files under `dir`, breadth-first, as git.inspect picks them (bounded). */
async function sourceFiles(fs: RepoFs, dir: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [dir];
  for (let seen = 0; queue.length && seen < MAX_DIRS && out.length < SOURCE_SCAN_MAX_FILES; seen++) {
    const d = queue.shift()!;
    for (const name of await fs.list(d)) {
      const p = joinRel(d, name);
      if (isSourcePath(p, dir)) out.push(p);
      else if (!SKIP.has(name) && !name.startsWith('.') && !name.includes('.')) queue.push(p);
      if (out.length >= SOURCE_SCAN_MAX_FILES) break;
    }
  }
  return out;
}

/** Read what the detectors read: manifests whole, source files as grep hits. */
export async function scanRepoFiles(fs: RepoFs, dir = ''): Promise<{ files: ScanFile[]; present: string[] }> {
  const files: ScanFile[] = [];
  for (const name of SCAN_FILES) {
    const text = await fs.read(joinRel(dir, name));
    if (text !== null) files.push(scanFile(joinRel(dir, name), text));
  }
  const present: string[] = [];
  for (const name of SCAN_PRESENCE_FILES) if (await fs.exists(joinRel(dir, name))) present.push(joinRel(dir, name));
  const re = new RegExp(SOURCE_SCAN_PATTERN);
  let budget = SOURCE_SCAN_MAX_HITS;
  for (const p of await sourceFiles(fs, dir)) {
    const lines = (await fs.read(p))?.split(/\r?\n/) ?? [];
    const hits = lines
      .map((text, i) => ({ line: i + 1, text: text.slice(0, 200) }))
      .filter((h) => re.test(h.text))
      .slice(0, Math.min(SOURCE_SCAN_MAX_HITS_PER_FILE, Math.max(budget, 0)));
    budget -= hits.length;
    files.push(scanHits(p, hits));
  }
  return { files, present };
}

/** The detections for the app in `dir`, with the stack detector's framework as the port hint. */
export async function findNeeds(fs: RepoFs, detected: StackDetection | null, dir = ''): Promise<ScanResult> {
  const { files, present } = await scanRepoFiles(fs, dir);
  const dep = detected?.framework ? frameworkDep(detected.framework) : undefined;
  return detectAppNeeds(files, {
    dir,
    present,
    ...(detected
      ? { framework: { name: describeDetection(detected), ...(detected.port ? { port: detected.port, healthPath: '/' } : {}), ...(dep ? { dep } : {}) } }
      : {}),
  });
}
