/**
 * Load a system image from the CONTROLLER instead of a public registry: what a
 * new node does for the images it needs before it can reach the cluster's
 * registry — the NetBird client for its first mesh join (the swarm, and so the
 * registry forwarder, only come after the mesh) and the forwarder's Caddy.
 * The controller serves per-arch `docker load` archives at
 * `/install/images/<file>` (`@swarmy/core/image-archive`).
 *
 * Trust: only a digest-pinned ref (the BOM pin compiled into this agent). The
 * archive is verified against that digest BEFORE `docker load`, and the loaded
 * image's id must be one the verified bytes yield. The image then runs BY ID:
 * the classic image store keeps no digest for a loaded image, so
 * `ref@sha256:…` would not resolve there. Every failure is null and the caller
 * pulls upstream as before. Never throws.
 */
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveFileName, archiveTarget, nodeArchivePlatform, verifyImageArchive } from '@swarmy/core/image-archive';

export interface ControllerImageDocker {
  docker: {
    loadImage(file: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream>;
    modem: { followProgress(s: NodeJS.ReadableStream, done: (err: Error | null, out: Array<{ error?: string }>) => void): void };
    getImage(ref: string): { inspect(): Promise<{ Id?: string }> };
  };
}

export interface ControllerImageOpts {
  /** The controller's HTTP base (default: from AGENT_WS_URL, like `swarmy-agent update`). */
  base?: string;
  fetchFn?: typeof fetch;
  arch?: string;
  log?: (...a: unknown[]) => void;
}

/** Archives are ~25 MB; refuse anything absurd before it fills the disk. */
const MAX_BYTES = 512 * 1024 * 1024;

async function defaultBase(): Promise<string> {
  const { env } = await import('../env');
  const u = new URL(env.AGENT_WS_URL);
  return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
}

function loadArchive(docker: ControllerImageDocker, file: string): Promise<void> {
  return docker.docker.loadImage(createReadStream(file)).then(
    (stream) =>
      new Promise<void>((resolve, reject) =>
        docker.docker.modem.followProgress(stream, (err, out) => {
          const bad = err?.message ?? out?.find((o) => o.error)?.error;
          if (bad) reject(new Error(bad));
          else resolve();
        }),
      ),
  );
}

/** The loaded image's id to run, or null (not pinned, not on the controller, or it didn't verify). */
export async function loadImageFromController(docker: ControllerImageDocker, ref: string, opts: ControllerImageOpts = {}): Promise<string | null> {
  const target = archiveTarget(ref);
  const platform = nodeArchivePlatform(opts.arch);
  const log = opts.log ?? (() => undefined);
  if (!target || !platform) return null;
  let dir: string | null = null;
  try {
    const url = `${(opts.base ?? (await defaultBase())).replace(/\/+$/, '')}/install/images/${archiveFileName(target.indexDigest, platform)}`;
    const res = await (opts.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) return null; // this controller doesn't carry it: pull upstream
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('the archive is too large');
    dir = await mkdtemp(join(tmpdir(), 'swarmy-image-'));
    const file = join(dir, 'image.tar');
    await Bun.write(file, res);
    const size = (await stat(file)).size;
    if (size > MAX_BYTES) throw new Error('the archive is too large');
    const fh = await open(file, 'r');
    let check;
    try {
      const read = async (offset: number, length: number) => {
        const buf = new Uint8Array(length);
        await fh.read(buf, 0, length, offset);
        return buf;
      };
      check = await verifyImageArchive(read, size, { ...target, platform });
    } finally {
      await fh.close();
    }
    if (!check.ok) throw new Error(`the controller's archive does not verify: ${check.reason}`);
    await loadArchive(docker, file);
    const id = (await docker.docker.getImage(target.name).inspect()).Id ?? '';
    if (!check.ids.includes(id)) throw new Error(`docker loaded ${id || 'nothing'}, not the verified image`);
    log(`loaded ${ref} from the controller (${platform})`);
    return id;
  } catch (e) {
    log(`could not load ${ref} from the controller: ${e instanceof Error ? e.message : String(e)}; pulling upstream`);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
