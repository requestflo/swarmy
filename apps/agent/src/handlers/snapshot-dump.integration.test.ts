/**
 * snapshotDump / snapshotLs against a REAL restic repo through the real
 * Docker attach stream: chunks reassemble byte for byte, a reader that stops
 * granting credit holds the agent at one window, and a cancel stops restic.
 * Needs a local Docker daemon with `restic/restic:0.16.4`; skips otherwise.
 *   bun test src/handlers/snapshot-dump.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { DockerClient } from '@swarmy/core/docker';
import { CreditReceiver, DEFAULT_RESTIC_IMAGE, decodeStreamChunk, type ResticRepo, type StreamEndPayload } from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';
import { handleSnapshotDump, handleStreamCancel, handleStreamCredit } from './snapshot-dump';
import { snapshotLs } from './snapshot-ls';

const docker = new DockerClient();
const VOL = `swarmy-dump-it-${process.pid}`;
const dir = mkdtempSync(join(process.env.SWARMY_IT_TMP ?? tmpdir(), 'swarmy-dump-'));
const repo: ResticRepo = { kind: 'node', repo: join(dir, 'repo'), password: 'pw' };
let ready = false;
let bigSha = '';

async function sh(image: string, cmd: string, binds: string[]): Promise<string> {
  const out: Buffer[] = [];
  const sink = new Writable({ write: (b: Buffer, _e, cb) => (out.push(b), cb()) });
  const [res] = (await docker.docker.run(image, ['sh', '-c', cmd], sink, {
    Env: [`RESTIC_REPOSITORY=${repo.repo}`, 'RESTIC_PASSWORD=pw'],
    Entrypoint: [],
    HostConfig: { Binds: binds, AutoRemove: true },
  })) as [{ StatusCode: number }];
  if (res.StatusCode !== 0) throw new Error(Buffer.concat(out).toString());
  return Buffer.concat(out).toString();
}

beforeAll(async () => {
  if (!(await docker.ping())) return;
  try {
    await docker.docker.getImage(DEFAULT_RESTIC_IMAGE).inspect();
    await sh(DEFAULT_RESTIC_IMAGE, 'mkdir -p /data/sub && head -c 3000000 /dev/urandom > /data/sub/big.bin && echo hi > /data/a.txt', [`${VOL}:/data`]);
    bigSha = (await sh(DEFAULT_RESTIC_IMAGE, 'sha256sum /data/sub/big.bin', [`${VOL}:/data:ro`])).slice(0, 64);
    await sh(DEFAULT_RESTIC_IMAGE, 'restic init -q && restic backup -q --host v /data', [`${VOL}:/data:ro`, `${repo.repo}:${repo.repo}`]);
    ready = true;
  } catch (e) {
    console.warn(`[snapshot-dump.it] skipped: ${e instanceof Error ? e.message : e}`);
  }
}, 120_000);

afterAll(async () => {
  await docker.docker.getVolume(VOL).remove().catch(() => undefined);
  await sh(DEFAULT_RESTIC_IMAGE, `rm -rf ${repo.repo}`, [`${dir}:${dir}`]).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** A fake controller link: decodes chunks, grants credit unless `hold`. */
function link(streamId: string, window = 8, hold = { on: false }) {
  const recv = new CreditReceiver(window, 1e10);
  const chunks: Uint8Array[] = [];
  let end!: (e: StreamEndPayload) => void;
  const ended = new Promise<StreamEndPayload>((r) => (end = r));
  const conn = {
    send: (type: string, p: StreamEndPayload) => type === 'streamEnd' && end(p),
    sendBinary: (frame: Uint8Array) => {
      const c = decodeStreamChunk(frame)!;
      expect(recv.arrive(c.seq, c.data.byteLength)).toEqual({ ok: true });
      chunks.push(c.data.slice());
      const give = () => {
        const grant = recv.consume();
        if (grant > 0) handleStreamCredit({ streamId, grant });
      };
      setTimeout(() => (hold.on ? undefined : give()), 1);
    },
  } as unknown as AgentConnection;
  return { conn, chunks, ended, recv };
}

const start = (id: string, conn: AgentConnection, path: string, kind: 'file' | 'dir', chunkBytes = 65_536) =>
  void handleSnapshotDump(docker, conn, { streamId: id, repo, snapshotId: 'latest', path, kind, credit: 8, chunkBytes, maxBytes: 1e10 });

describe('snapshot download against a real restic repo', () => {
  test('a file arrives byte for byte through credit-limited chunks', async () => {
    if (!ready) return;
    const id = crypto.randomUUID();
    const l = link(id);
    start(id, l.conn, '/data/sub/big.bin', 'file');
    const end = await l.ended;
    expect(end).toMatchObject({ ok: true, bytes: 3_000_000 });
    expect(l.recv.matches(end as { bytes: number; chunks: number })).toBe(true);
    const all = Buffer.concat(l.chunks);
    expect(new Bun.CryptoHasher('sha256').update(all).digest('hex')).toBe(bigSha);
  }, 60_000);

  test('a reader that stops granting holds the agent at one window, and a cancel stops it', async () => {
    if (!ready) return;
    const id = crypto.randomUUID();
    const hold = { on: true };
    const l = link(id, 8, hold);
    start(id, l.conn, '/data', 'dir', 16_384);
    await Bun.sleep(4_000);
    expect(l.chunks.length).toBe(8); // paused: the container blocks, nothing piles up
    handleStreamCancel({ streamId: id, reason: 'test' });
    expect(await l.ended).toMatchObject({ ok: false, error: { code: 'E_CANCELED' } });
  }, 60_000);

  test('a folder arrives as a tar, and a missing path says so', async () => {
    if (!ready) return;
    const id = crypto.randomUUID();
    const l = link(id);
    start(id, l.conn, '/data/sub', 'dir');
    expect(await l.ended).toMatchObject({ ok: true });
    const tar = Buffer.concat(l.chunks);
    expect(tar.subarray(0, 100).toString().replace(/\0+$/, '')).toBe('data/sub/big.bin');
    const miss = crypto.randomUUID();
    const m = link(miss);
    start(miss, m.conn, '/data/nope', 'file');
    expect(await m.ended).toMatchObject({ ok: false, error: { code: 'E_NOT_FOUND' } });
  }, 60_000);

  test('snapshotLs lists one folder and finds a file', async () => {
    if (!ready) return;
    const base = { commandId: crypto.randomUUID(), repo, snapshotId: 'latest', limit: 500 };
    const root = await snapshotLs(docker, { ...base, path: '/data' });
    expect(root.node?.type).toBe('dir');
    expect(root.entries.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:sub', 'file:a.txt']);
    const file = await snapshotLs(docker, { ...base, path: '/data/sub/big.bin' });
    expect(file.node).toMatchObject({ type: 'file', size: 3_000_000 });
    expect((await snapshotLs(docker, { ...base, path: '/data/nope' })).node).toBeNull();
  }, 60_000);
});
