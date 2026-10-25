/**
 * Offline bundle upload — Settings › Platform › Import release › Bundle.
 *
 * The browser sends the `.tar` in base64 chunks (each under the controller's
 * 32 MB request cap) to a file on the controller's disk, then Finish loads it
 * in the background (`platform-bundle.load.ts`) while the page polls Status.
 * A chunk names its offset, so a retried chunk is a no-op and an upload
 * resumes from `received`. Upload state is process memory (like terminal
 * tickets): a controller restart drops it and the person uploads again.
 */
import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrgContext } from '../context';
import { badRequest, commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { importRelease } from './platform-release.service';
import { loadBundle, resolveRegistryTarget, type BundleProgress, type LoadBundleDeps } from './platform-bundle.load';

/** Raw bytes per chunk: 8 MiB → ~11 MB of base64, well inside the 32 MB body cap. */
export const BUNDLE_CHUNK_BYTES = 8 * 1024 * 1024;
export const BUNDLE_MAX_BYTES = 64 * 1024 ** 3;
const STALE_MS = 6 * 60 * 60_000;

export type BundlePhase = 'receiving' | 'loading' | 'done' | 'failed';

export interface BundleUploadView extends BundleProgress {
  id: string;
  name: string;
  phase: BundlePhase;
  size: number;
  received: number;
  error: string | null;
}

interface Upload extends BundleUploadView {
  orgId: string;
  /** Who began it (passed the `authconfig.write` gate): the only one who may add to it. */
  userId: string | null;
  path: string;
  touchedAt: number;
}

const uploads = new Map<string, Upload>();

const defaultDeps: LoadBundleDeps = { fetch, registry: resolveRegistryTarget, importRelease };

function bundleDir(): string {
  return process.env.SWARMY_BUNDLE_DIR?.trim() || join(tmpdir(), 'swarmy-platform-bundles');
}

function view(u: Upload): BundleUploadView {
  const { orgId: _o, userId: _u, path: _p, touchedAt: _t, ...v } = u;
  return { ...v };
}

function own(ctx: OrgContext, id: string): Upload {
  const u = uploads.get(id);
  if (!u || u.orgId !== ctx.activeOrgId || u.userId !== (ctx.user?.id ?? null)) throw notFound('bundle upload', id);
  return u;
}

async function drop(u: Upload): Promise<void> {
  uploads.delete(u.id);
  await rm(u.path, { force: true }).catch(() => undefined);
}

/** Start an upload. Replaces this org's unfinished one; refuses while a bundle is loading. */
export async function beginBundleUpload(ctx: OrgContext, input: { name: string; size: number }): Promise<BundleUploadView> {
  if (input.size < 1024 || input.size > BUNDLE_MAX_BYTES) throw badRequest('that is not a swarmy bundle (the size is out of range)');
  const now = Date.now();
  for (const u of [...uploads.values()]) {
    if (u.phase === 'loading' && u.orgId === ctx.activeOrgId) throw commandRejected('a bundle is already loading — wait for it to finish');
    if (u.orgId === ctx.activeOrgId || now - u.touchedAt > STALE_MS) await drop(u);
  }
  await mkdir(bundleDir(), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const u: Upload = {
    id,
    name: input.name.slice(0, 200),
    phase: 'receiving',
    size: input.size,
    received: 0,
    error: null,
    orgId: ctx.activeOrgId,
    userId: ctx.user?.id ?? null,
    path: join(bundleDir(), `${id}.tar`),
    touchedAt: now,
  };
  await writeFile(u.path, new Uint8Array(0), { mode: 0o600 });
  uploads.set(id, u);
  return view(u);
}

/** Append one chunk at `offset`. A chunk already received is ignored (a retry). */
export async function appendBundleChunk(ctx: OrgContext, input: { id: string; offset: number; data: string }): Promise<BundleUploadView> {
  const u = own(ctx, input.id);
  if (u.phase !== 'receiving') throw commandRejected(`this upload is ${u.phase}`);
  const bytes = Buffer.from(input.data, 'base64');
  if (input.offset + bytes.length > u.size) throw badRequest('the chunk runs past the declared size');
  if (input.offset + bytes.length <= u.received) return view(u);
  if (input.offset !== u.received) throw badRequest(`expected the chunk at byte ${u.received}, got ${input.offset}`);
  await appendFile(u.path, bytes);
  u.received += bytes.length;
  u.touchedAt = Date.now();
  return view(u);
}

/** Every byte is in: verify + load in the background. Poll {@link bundleUploadStatus}. */
export async function finishBundleUpload(
  ctx: OrgContext,
  input: { id: string },
  deps: LoadBundleDeps = defaultDeps,
  opts: { wait?: boolean } = {},
): Promise<BundleUploadView> {
  const u = own(ctx, input.id);
  if (u.phase !== 'receiving') throw commandRejected(`this upload is ${u.phase}`);
  if (u.received !== u.size) throw badRequest(`only ${u.received} of ${u.size} bytes arrived`);
  u.phase = 'loading';
  // runLoad never rejects: every failure lands on the upload as `failed`.
  const done = runLoad(ctx, u, deps);
  if (opts.wait) await done;
  return view(u);
}

async function runLoad(ctx: OrgContext, u: Upload, deps: LoadBundleDeps): Promise<void> {
  try {
    // A disk-backed Blob: slices stream from the file, nothing is held in memory.
    // (the ambient Blob typing here omits `slice`; the runtime Blob has it)
    const file = (await openAsBlob(u.path)) as unknown as { slice(start: number, end: number): Blob };
    const io = {
      size: u.size,
      read: async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
      slice: (offset: number, size: number) => file.slice(offset, offset + size),
    };
    const r = await loadBundle(ctx, io, deps, (p) => Object.assign(u, p, { touchedAt: Date.now() }));
    Object.assign(u, { phase: 'done', version: r.version });
    await writeAudit(ctx, { action: 'platform.bundle.load', targetType: 'platformRelease', targetId: r.version, metadata: { file: u.name, size: u.size, images: r.images, ...(r.omitted.length ? { omitted: r.omitted } : {}) } });
  } catch (e) {
    Object.assign(u, { phase: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 2000) });
    await writeAudit(ctx, { action: 'platform.bundle.load', targetType: 'platformRelease', targetId: u.version ?? u.name, metadata: { file: u.name, failed: u.error } });
  } finally {
    u.touchedAt = Date.now();
    await rm(u.path, { force: true }).catch(() => undefined);
  }
}

export function bundleUploadStatus(ctx: OrgContext, input: { id: string }): BundleUploadView {
  return view(own(ctx, input.id));
}
