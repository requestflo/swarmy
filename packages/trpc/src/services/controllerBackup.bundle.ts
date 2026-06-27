/**
 * Controller-state bundle: build / encrypt / restic-store / restore primitives.
 *
 * This is the controller-side counterpart to the volumes-DR restic mechanism.
 * It runs IN THE CONTROLLER PROCESS (never on an agent) because the bundle
 * contains the controller's own secrets and must work before any agent exists.
 *
 * The bundle is a self-describing directory:
 *   manifest.json   — version/db-driver/timestamp/org+node counts (preflight)
 *   db.sql          — logical SQL dump (portable across lite↔managed↔external)
 *   secrets.json    — SWARMY_SECRET_KEY, BETTER_AUTH_SECRET, controller config
 *
 * The directory is tar+passphrase-encrypted into `bundle.swcb` (user-held
 * passphrase, NOT the vault key) and that single artefact is what restic stores.
 * So even a by-hand recovery is: `restic restore` → decrypt `bundle.swcb` with
 * the passphrase → load db.sql → set secrets → start controller.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResticRepo } from '@swarmy/core/protocol';
import {
  decryptWithPassphrase,
  encryptWithPassphrase,
} from '@swarmy/core/crypto';

export const CONTROLLER_BACKUP_TAG = 'swarmy.controller-state';
export const DEFAULT_RESTIC_IMAGE = 'restic/restic:0.16.4';
const BUNDLE_FILE = 'bundle.swcb';

export interface ControllerManifest {
  swarmyVersion: string;
  schemaVersion: string;
  dbDriver: 'pglite' | 'postgres';
  createdAt: string;
  orgCount: number;
  nodeCount: number;
  /** Tables included in the logical dump (metrics excluded — rebuildable). */
  includedTables: 'control-plane' | 'all';
}

export interface ControllerSecrets {
  SWARMY_SECRET_KEY: string;
  BETTER_AUTH_SECRET?: string;
  config: Record<string, string>;
}

export interface BundleContents {
  manifest: ControllerManifest;
  /** Logical SQL dump bytes. */
  dbDump: Buffer;
  secrets: ControllerSecrets;
}

// ── restic invocation (controller-side) ─────────────────────────────────────

/**
 * How restic is run on the controller host. `binary` execs a local `restic`;
 * `docker` runs the pinned image as a short-lived container with the staging dir
 * bind-mounted. Defaults to `binary` (controller image ships restic).
 */
export interface ResticRunner {
  mode: 'binary' | 'docker';
  /** Override the restic binary path (mode=binary) or image (mode=docker). */
  resticPath?: string;
  image?: string;
}

export function defaultRunner(env: NodeJS.ProcessEnv = process.env): ResticRunner {
  const mode = (env.SWARMY_CONTROLLER_RESTIC_MODE === 'docker' ? 'docker' : 'binary') as
    | 'binary'
    | 'docker';
  return {
    mode,
    resticPath: env.SWARMY_RESTIC_BINARY,
    image: env.SWARMY_RESTIC_IMAGE ?? DEFAULT_RESTIC_IMAGE,
  };
}

function resticEnv(repo: ResticRepo): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RESTIC_REPOSITORY: repo.repo,
    RESTIC_PASSWORD: repo.password,
  };
  if (repo.accessKeyId) env.AWS_ACCESS_KEY_ID = repo.accessKeyId;
  if (repo.secretAccessKey) env.AWS_SECRET_ACCESS_KEY = repo.secretAccessKey;
  if (repo.region) env.AWS_DEFAULT_REGION = repo.region;
  return env;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a restic subcommand, returning its captured output. Never rejects on non-zero. */
export function runRestic(
  args: string[],
  repo: ResticRepo,
  runner: ResticRunner,
  opts: { mountDir?: string } = {},
): Promise<RunResult> {
  let cmd: string;
  let fullArgs: string[];
  if (runner.mode === 'docker') {
    const image = runner.image ?? DEFAULT_RESTIC_IMAGE;
    const envFlags = Object.entries(resticEnv(repo))
      .filter(([k]) => k.startsWith('RESTIC_') || k.startsWith('AWS_'))
      .flatMap(([k, v]) => ['-e', `${k}=${v ?? ''}`]);
    const mount = opts.mountDir ? ['-v', `${opts.mountDir}:${opts.mountDir}`] : [];
    cmd = 'docker';
    fullArgs = ['run', '--rm', ...envFlags, ...mount, image, ...args];
  } else {
    cmd = runner.resticPath ?? 'restic';
    fullArgs = args;
  }
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, fullArgs, {
      env: runner.mode === 'docker' ? process.env : resticEnv(repo),
    }) as unknown as {
      stdout: { on(ev: 'data', cb: (d: Buffer) => void): void };
      stderr: { on(ev: 'data', cb: (d: Buffer) => void): void };
      on(ev: 'error', cb: (e: Error) => void): void;
      on(ev: 'close', cb: (code: number | null) => void): void;
    };
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Ensure the restic repo exists (idempotent: `init` is a no-op if present). */
export async function ensureRepo(repo: ResticRepo, runner: ResticRunner): Promise<void> {
  const cat = await runRestic(['cat', 'config'], repo, runner);
  if (cat.code === 0) return;
  const init = await runRestic(['init'], repo, runner);
  if (init.code !== 0 && !/already initialized/i.test(init.stderr)) {
    throw new Error(`restic init failed: ${init.stderr || init.stdout}`);
  }
}

// ── bundle build / write ────────────────────────────────────────────────────

/** Write the bundle contents into a fresh staging dir and return paths. */
export async function stageBundle(
  contents: BundleContents,
): Promise<{ dir: string; bundlePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'swarmy-cb-stage-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(contents.manifest, null, 2));
  await writeFile(join(dir, 'db.sql'), contents.dbDump);
  await writeFile(join(dir, 'secrets.json'), JSON.stringify(contents.secrets, null, 2));
  return { dir, bundlePath: join(dir, BUNDLE_FILE) };
}

/**
 * Serialise the staging files into a single plaintext blob, then encrypt with
 * the user-held passphrase. We use a tiny self-describing length-prefixed
 * container instead of a tar dependency — three known files, fixed order.
 */
export function serializeBundle(contents: BundleContents): Buffer {
  const parts: Record<string, Buffer> = {
    'manifest.json': Buffer.from(JSON.stringify(contents.manifest)),
    'db.sql': Buffer.from(contents.dbDump),
    'secrets.json': Buffer.from(JSON.stringify(contents.secrets)),
  };
  const chunks: Buffer[] = [Buffer.from('SWCBSTORE1')];
  for (const [name, data] of Object.entries(parts)) {
    const nameBuf = Buffer.from(name);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(nameBuf.length, 0);
    head.writeUInt32BE(data.length, 4);
    chunks.push(head, nameBuf, data);
  }
  return Buffer.concat(chunks);
}

export function deserializeBundle(blob: Buffer): BundleContents {
  const magic = Buffer.from('SWCBSTORE1');
  if (!blob.subarray(0, magic.length).equals(magic)) {
    throw new Error('corrupt controller-state bundle (bad store magic)');
  }
  let o = magic.length;
  const files: Record<string, Buffer> = {};
  while (o < blob.length) {
    const nameLen = blob.readUInt32BE(o);
    const dataLen = blob.readUInt32BE(o + 4);
    o += 8;
    const name = blob.subarray(o, o + nameLen).toString();
    o += nameLen;
    const data = blob.subarray(o, o + dataLen);
    o += dataLen;
    files[name] = Buffer.from(data);
  }
  if (!files['manifest.json'] || !files['db.sql'] || !files['secrets.json']) {
    throw new Error('controller-state bundle is missing required members');
  }
  return {
    manifest: JSON.parse(files['manifest.json'].toString()) as ControllerManifest,
    dbDump: files['db.sql'],
    secrets: JSON.parse(files['secrets.json'].toString()) as ControllerSecrets,
  };
}

export interface CreateBundleResult {
  resticSnapshotId: string;
  sizeBytes: number;
  durationMs: number;
}

/**
 * Build + encrypt + store a controller-state bundle to a restic repo.
 * `passphrase` is the user-held restore key; the staging dir is removed after.
 */
export async function createAndStoreBundle(args: {
  contents: BundleContents;
  passphrase: string;
  repo: ResticRepo;
  runner?: ResticRunner;
  extraTags?: string[];
}): Promise<CreateBundleResult> {
  const runner = args.runner ?? defaultRunner();
  const started = Date.now();
  await ensureRepo(args.repo, runner);

  const encrypted = encryptWithPassphrase(serializeBundle(args.contents), args.passphrase);
  const dir = await mkdtemp(join(tmpdir(), 'swarmy-cb-'));
  try {
    const bundlePath = join(dir, BUNDLE_FILE);
    await writeFile(bundlePath, encrypted);
    const tags = [CONTROLLER_BACKUP_TAG, ...(args.extraTags ?? [])];
    const res = await runRestic(
      ['backup', '--json', '--tag', tags.join(','), bundlePath],
      args.repo,
      runner,
      { mountDir: dir },
    );
    if (res.code !== 0) {
      throw new Error(`restic backup failed: ${res.stderr || res.stdout}`);
    }
    const summary = parseBackupSummary(res.stdout);
    return {
      resticSnapshotId: summary.snapshotId,
      sizeBytes: summary.sizeBytes ?? encrypted.length,
      durationMs: Date.now() - started,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseBackupSummary(stdout: string): { snapshotId: string; sizeBytes?: number } {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        message_type?: string;
        snapshot_id?: string;
        total_bytes_processed?: number;
      };
      if (obj.message_type === 'summary' && obj.snapshot_id) {
        return { snapshotId: obj.snapshot_id, sizeBytes: obj.total_bytes_processed };
      }
    } catch {
      // not the summary line
    }
  }
  return { snapshotId: 'unknown' };
}

/** One restic snapshot as reported by `restic snapshots --json`. */
export interface ResticSnapshotRow {
  id: string;
  time: string;
  tags: string[];
}

export async function listBundleSnapshots(
  repo: ResticRepo,
  runner: ResticRunner = defaultRunner(),
): Promise<ResticSnapshotRow[]> {
  const res = await runRestic(
    ['snapshots', '--json', '--tag', CONTROLLER_BACKUP_TAG],
    repo,
    runner,
  );
  if (res.code !== 0) return [];
  try {
    const rows = JSON.parse(res.stdout) as { id: string; short_id?: string; time: string; tags?: string[] }[];
    return rows.map((r) => ({ id: r.short_id ?? r.id, time: r.time, tags: r.tags ?? [] }));
  } catch {
    return [];
  }
}

/**
 * Restore + decrypt a controller-state bundle from a restic repo. Returns the
 * decoded contents (manifest + db dump + secrets) for the restore CLI/UI to act
 * on. Restores to a temp dir which is cleaned up.
 */
export async function restoreBundle(args: {
  repo: ResticRepo;
  snapshotId?: string;
  passphrase: string;
  runner?: ResticRunner;
}): Promise<BundleContents> {
  const runner = args.runner ?? defaultRunner();
  const dir = await mkdtemp(join(tmpdir(), 'swarmy-cb-restore-'));
  try {
    await mkdir(dir, { recursive: true });
    const res = await runRestic(
      ['restore', args.snapshotId ?? 'latest', '--target', dir],
      args.repo,
      runner,
      { mountDir: dir },
    );
    if (res.code !== 0) {
      throw new Error(`restic restore failed: ${res.stderr || res.stdout}`);
    }
    // restic restores preserving the absolute source path; find bundle.swcb.
    const found = await findBundleFile(dir);
    const encrypted = await readFile(found);
    const blob = decryptWithPassphrase(encrypted, args.passphrase);
    return deserializeBundle(blob);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function findBundleFile(root: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === BUNDLE_FILE) return full;
    }
  }
  throw new Error(`restored snapshot did not contain ${BUNDLE_FILE}`);
}
