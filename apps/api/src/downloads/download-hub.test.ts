import { describe, expect, it } from 'bun:test';
import { encodeStreamChunk } from '@swarmy/core/protocol';
import type { DownloadClaims } from '@swarmy/trpc';
import { DownloadHub } from './download-hub';
import { downloadResponse, handleBackupDownload } from './route';

const ID = '5f0c2a1e-9b3d-4c7a-8e21-0d4f6a8b2c3e';
const claims = (over: Partial<DownloadClaims> = {}): DownloadClaims => ({
  downloadId: ID, orgId: 'org1', userId: 'u1', nodeId: 'n1', maxBytes: 1000, fileName: 'v-a.txt-20261027-0300.tar.gz',
  start: { repo: { kind: 's3', repo: 's3:x/b', password: 'pw' }, snapshotId: 'abc', path: '/data/a.txt', kind: 'file' },
  audit: { snapshotId: 'snap1', volume: 'v', path: 'a.txt' },
  ...over,
});

function setup(caps = ['snapshotDump']) {
  const sent: Array<{ nodeId: string; type: string; payload: Record<string, unknown> }> = [];
  const audits: Array<{ outcome: string; bytes: number; error: string | null }> = [];
  const hub = new DownloadHub({
    maxLive: 2,
    send: (nodeId, type, payload) => (sent.push({ nodeId, type, payload: payload as Record<string, unknown> }), true),
    isOnline: (n) => n !== 'off',
    capabilities: () => caps,
    audit: (_c, outcome, bytes, error) => audits.push({ outcome, bytes, error }),
  });
  return { hub, sent, audits, of: (type: string) => sent.filter((s) => s.type === type) };
}

const bytes = (n: number, from = 0) => Uint8Array.from({ length: n }, (_, i) => (from + i) % 251);

describe('DownloadHub tickets', () => {
  it('a ticket opens once, only for the person it was minted for', () => {
    const { hub } = setup();
    const a = hub.mint(claims());
    expect(hub.open(a.ticket, 'someone-else')).toMatchObject({ ok: false, status: 403 });
    expect(hub.open(a.ticket, 'u1')).toMatchObject({ ok: false, status: 410 }); // spent by the refused try
    const b = hub.mint(claims());
    expect(hub.open(b.ticket, 'u1').ok).toBe(true);
    expect(hub.open(b.ticket, 'u1')).toMatchObject({ ok: false, status: 410 });
  });

  it('refuses an offline server and an agent without the capability', () => {
    const off = setup();
    expect(off.hub.open(off.hub.mint(claims({ nodeId: 'off' })).ticket, 'u1')).toMatchObject({ ok: false, status: 503 });
    const old = setup([]);
    expect(old.hub.open(old.hub.mint(claims()).ticket, 'u1')).toMatchObject({ ok: false, message: expect.stringContaining('too old') });
    expect(old.hub.statusOf(ID)).toMatchObject({ state: 'failed' });
  });
});

describe('DownloadHub limits', () => {
  it('refuses a download past the controller-wide limit, in words, until one ends', () => {
    const { hub } = setup();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const opened = ids.map((downloadId) => hub.open(hub.mint(claims({ downloadId })).ticket, 'u1'));
    expect(opened.map((o) => o.ok)).toEqual([true, true, false]);
    expect(hub.statusOf(ids[2]!)!.error).toContain('2 downloads are already running');
    hub.onAgentGone('n1');
    expect(hub.open(hub.mint(claims()).ticket, 'u1').ok).toBe(true);
  });
});

describe('DownloadHub streams', () => {
  it('starts the agent with one window, re-grants as the body is read, and finishes', async () => {
    const { hub, sent, of, audits } = setup();
    const o = hub.open(hub.mint(claims({ maxBytes: 10_000 })).ticket, 'u1');
    if (!o.ok) throw new Error('not opened');
    expect(of('snapshotDump')[0]!.payload).toMatchObject({ streamId: ID, credit: 8, chunkBytes: 262_144, maxBytes: 10_000, path: '/data/a.txt' });
    for (let seq = 0; seq < 8; seq++) hub.onChunk('n1', encodeStreamChunk(ID, seq, bytes(10, seq * 10)));
    expect(of('streamCredit')).toEqual([]); // nobody has read yet
    const reader = o.body.getReader();
    for (let i = 0; i < 4; i++) await reader.read();
    expect(of('streamCredit').map((s) => s.payload.grant)).toEqual([4]);
    hub.onEnd('n1', { streamId: ID, ok: true, bytes: 80, chunks: 8 });
    let got = 40;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      got += r.value.byteLength;
    }
    expect(got).toBe(80);
    expect(hub.statusOf(ID)).toMatchObject({ state: 'done', bytes: 80, error: null });
    expect(audits).toEqual([{ outcome: 'done', bytes: 80, error: null }]);
    expect(sent.every((s) => s.nodeId === 'n1')).toBe(true);
  });

  it('ignores another node’s chunks and cancels chunks nobody is reading', () => {
    const { hub, of } = setup();
    hub.open(hub.mint(claims()).ticket, 'u1');
    hub.onChunk('n2', encodeStreamChunk(ID, 0, bytes(5)));
    expect(hub.statusOf(ID)).toMatchObject({ state: 'streaming', bytes: 0 });
    const stray = crypto.randomUUID();
    hub.onChunk('n2', encodeStreamChunk(stray, 0, bytes(5)));
    expect(of('streamCancel')).toEqual([{ nodeId: 'n2', type: 'streamCancel', payload: { streamId: stray, reason: 'no reader for this download' } }]);
  });

  it('the agent going away, an over-cap chunk, a short end and a closed browser all stop it, in words', async () => {
    const gone = setup();
    const g = gone.hub.open(gone.hub.mint(claims()).ticket, 'u1');
    gone.hub.onAgentGone('n1');
    expect(gone.hub.statusOf(ID)).toMatchObject({ state: 'failed', error: expect.stringContaining('disconnected partway') });
    if (g.ok) await expect(g.body.getReader().read()).rejects.toThrow();

    const big = setup();
    big.hub.open(big.hub.mint(claims({ maxBytes: 8 })).ticket, 'u1');
    big.hub.onChunk('n1', encodeStreamChunk(ID, 0, bytes(9)));
    expect(big.hub.statusOf(ID)!.error).toContain('downloads stop at 8 B (SWARMY_BACKUP_DOWNLOAD_MAX_BYTES');
    expect(big.of('streamCancel').length).toBe(1);

    const short = setup();
    short.hub.open(short.hub.mint(claims()).ticket, 'u1');
    short.hub.onEnd('n1', { streamId: ID, ok: true, bytes: 10, chunks: 1 });
    expect(short.hub.statusOf(ID)).toMatchObject({ state: 'failed' });

    const closed = setup();
    const c = closed.hub.open(closed.hub.mint(claims()).ticket, 'u1');
    if (c.ok) await c.body.cancel();
    expect(closed.hub.statusOf(ID)).toMatchObject({ state: 'canceled' });
    expect(closed.of('streamCancel')[0]!.payload).toMatchObject({ streamId: ID });
  });
});

describe('the download route', () => {
  it('needs a ticket and a signed-in person', async () => {
    const open = () => ({ ok: false as const, status: 410, message: 'gone' });
    const anon = { sessionUserId: async () => null, open };
    expect((await handleBackupDownload(new Request('http://x/api/backups/download'), anon)).status).toBe(400);
    expect((await handleBackupDownload(new Request('http://x/api/backups/download?ticket=t'), anon)).status).toBe(401);
    const signed = { sessionUserId: async () => 'u1', open };
    expect((await handleBackupDownload(new Request('http://x/api/backups/download?ticket=t', { method: 'POST' }), signed)).status).toBe(405);
    expect((await handleBackupDownload(new Request('http://x/api/backups/download?ticket=t'), signed)).status).toBe(410);
  });

  it('serves a single file as a gzipped one-entry tar with safe headers', async () => {
    const data = new TextEncoder().encode('hello\n');
    const res = downloadResponse(claims({ entry: { name: 'data/a.txt', size: 6, mtimeMs: 0 } }), new Blob([data]).stream());
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="v-a.txt-20261027-0300.tar.gz"; filename*=UTF-8''v-a.txt-20261027-0300.tar.gz`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const tar = Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(new TextDecoder().decode(tar.subarray(0, 10))).toBe('data/a.txt');
    expect(new TextDecoder().decode(tar.subarray(512, 518))).toBe('hello\n');
  });
});
