/**
 * Reading the replica's lineage (the writer marker and the head TXID) over S3,
 * plus the local marker and sidecar files next to control.db.
 *
 * Litestream v0.5's S3 client lays a replica out as `<prefix>/db/<level:4>/<min>-<max>.ltx`
 * (level 0000…0009, TXIDs 16 hex digits; the local meta dir uses `ltx/<level>/`). swarmy's writer marker sits beside it at
 * `<prefix>/writer.json`, outside Litestream's path so its retention never
 * touches it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { S3Client } from 'bun';
import type { ReplicaTarget, StorePaths } from './config';
import type { WriterMarker } from './restore-select';

export function litestreamPath(t: ReplicaTarget): string {
  return `${t.prefix.replace(/\/+$/, '')}/db`;
}

export function markerKey(t: ReplicaTarget): string {
  return `${t.prefix.replace(/\/+$/, '')}/writer.json`;
}

function client(t: ReplicaTarget): S3Client {
  return new S3Client({
    endpoint: t.endpoint,
    bucket: t.bucket,
    region: t.region,
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
  });
}

const LTX_RE = /\/(?:ltx\/)?\d+\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/;

/** Highest max-TXID across the LTX keys (all levels). 0n = no data. */
export function headTxidFromKeys(keys: string[]): bigint {
  let head = 0n;
  for (const k of keys) {
    const m = LTX_RE.exec(k);
    if (!m) continue;
    const max = BigInt(`0x${m[2]}`);
    if (max > head) head = max;
  }
  return head;
}

export interface ReplicaState {
  reachable: boolean;
  hasData: boolean;
  headTxid: bigint;
  marker: WriterMarker | null;
  error?: string;
}

export async function readReplicaState(t: ReplicaTarget): Promise<ReplicaState> {
  const s3 = client(t);
  try {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await s3.list({ prefix: `${litestreamPath(t)}/`, maxKeys: 1000, ...(token ? { continuationToken: token } : {}) });
      for (const c of page.contents ?? []) keys.push(c.key);
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
    const headTxid = headTxidFromKeys(keys);
    let marker: WriterMarker | null = null;
    const f = s3.file(markerKey(t));
    if (await f.exists()) marker = parseMarker(await f.text());
    return { reachable: true, hasData: headTxid > 0n, headTxid, marker };
  } catch (e) {
    return { reachable: false, hasData: false, headTxid: 0n, marker: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function writeReplicaMarker(t: ReplicaTarget, m: WriterMarker): Promise<void> {
  await client(t).write(markerKey(t), JSON.stringify(m), { type: 'application/json' });
}

export function parseMarker(raw: string | null | undefined): WriterMarker | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<WriterMarker>;
    if (typeof v.holder === 'string' && typeof v.epoch === 'number') return v as WriterMarker;
  } catch {
    // unreadable marker = unknown lineage
  }
  return null;
}

export function readLocalMarker(p: StorePaths): WriterMarker | null {
  try {
    return parseMarker(readFileSync(p.marker, 'utf8'));
  } catch {
    return null;
  }
}

export function writeLocalMarker(p: StorePaths, m: WriterMarker): void {
  mkdirSync(p.dir, { recursive: true });
  const tmp = `${p.marker}.tmp`;
  writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  renameSync(tmp, p.marker);
}

/** A local control.db that holds data (SQLite writes a 0-byte file on open). */
export function localDbExists(p: StorePaths): boolean {
  try {
    return statSync(p.db).size > 0;
  } catch {
    return false;
  }
}

/**
 * Delete everything that describes the OLD file: the WAL and shm, Litestream's
 * meta dir, and our marker. Call this when a different file is put in place,
 * or Litestream/SQLite would replay the old WAL onto the new file.
 */
export function clearSidecarFiles(dbPath: string): void {
  const dir = dbPath.slice(0, dbPath.lastIndexOf('/')) || '.';
  const base = dbPath.slice(dbPath.lastIndexOf('/') + 1);
  for (const p of [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`, `${dir}/.${base}-swarmy.json`]) {
    rmSync(p, { force: true });
  }
  rmSync(`${dir}/.${base}-litestream`, { recursive: true, force: true });
}

/** Keep a stale local file (and its WAL) as `<db>.stale-<ts>` rather than deleting it. */
export function moveAsideLocal(p: StorePaths, now = new Date()): string | null {
  if (!existsSync(p.db)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = `${p.db}.stale-${stamp}`;
  renameSync(p.db, dest);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(`${p.db}${ext}`)) renameSync(`${p.db}${ext}`, `${dest}${ext}`);
  }
  clearSidecarFiles(p.db);
  return dest;
}
