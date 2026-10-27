import { describe, expect, it } from 'bun:test';
import { StreamCancelMsg, StreamCreditMsg, StreamCreditPayload, StreamEndMsg, StreamEndPayload } from './stream';
import { SnapshotDumpMsg, SnapshotDumpPayload, SnapshotLsMsg, SnapshotLsPayload, SnapshotLsResult, SnapshotPath } from './snapshot-dump';
import { AgentEnvelope, ControllerEnvelope } from './messages';
import { AGENT_CAPABILITIES, AGENT_CAPABILITY, agentSupports } from './capabilities';

const ID = '00000000-0000-4000-8000-000000000001';
const REPO = { kind: 's3' as const, repo: 's3:https://s3.example.com/b', password: 'pw' };
const env = (type: string, payload: unknown) => ({ v: 1, id: ID, ts: 1, type, payload });

describe('SnapshotPath (never outside the snapshot volume)', () => {
  it('accepts the volume root and paths under it, any filename characters', () => {
    for (const p of ['/data', '/data/a.txt', '/data/sub/ünï cøde.txt', '/data/.env', '/data/..hidden', '/data/a b/c']) {
      expect(SnapshotPath.safeParse(p).success).toBe(true);
    }
  });
  it('rejects traversal, relative, empty segments, other roots and control characters', () => {
    for (const p of ['/data/..', '/data/../etc', '/data/a/../../x', '/data/.', '/data//a', '/data/', 'data/a', '/etc/passwd', '/datax', '-data', '/data/a\nb', '/data/a\u0000']) {
      expect(SnapshotPath.safeParse(p).success).toBe(false);
    }
  });
});

describe('snapshotLs', () => {
  it('defaults the path to the volume root and the limit to 500', () => {
    const r = SnapshotLsPayload.parse({ commandId: ID, repo: REPO, snapshotId: 'abc123' });
    expect(r.path).toBe('/data');
    expect(r.limit).toBe(500);
  });
  it('rejects an option-shaped snapshot id and a traversal path', () => {
    expect(SnapshotLsPayload.safeParse({ commandId: ID, repo: REPO, snapshotId: '--x' }).success).toBe(false);
    expect(SnapshotLsPayload.safeParse({ commandId: ID, repo: REPO, snapshotId: 'a', path: '/data/../x' }).success).toBe(false);
  });
  it('round-trips through the controller envelope with its discriminant', () => {
    const r = ControllerEnvelope.safeParse(env('snapshotLs', { commandId: ID, repo: REPO, snapshotId: 'abc' }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('snapshotLs');
    expect(SnapshotLsMsg.safeParse({ type: 'snapshotDump', payload: { commandId: ID, repo: REPO, snapshotId: 'a' } }).success).toBe(false);
  });
  it('parses a result with a missing node', () => {
    expect(SnapshotLsResult.parse({ node: null })).toEqual({ node: null, entries: [], truncated: false });
  });
});

describe('snapshotDump (stream start)', () => {
  const ok = { streamId: ID, repo: REPO, snapshotId: 'abc', path: '/data/sub', kind: 'dir', credit: 8, maxBytes: 1024 };
  it('accepts a minimal start and defaults the chunk size to 256 KiB', () => {
    expect(SnapshotDumpPayload.parse(ok).chunkBytes).toBe(262_144);
  });
  it('rejects credit past the cap, a zero byte cap and an unknown kind', () => {
    expect(SnapshotDumpPayload.safeParse({ ...ok, credit: 65 }).success).toBe(false);
    expect(SnapshotDumpPayload.safeParse({ ...ok, maxBytes: 0 }).success).toBe(false);
    expect(SnapshotDumpPayload.safeParse({ ...ok, kind: 'zip' }).success).toBe(false);
  });
  it('round-trips through the controller envelope; a wrong type literal is refused', () => {
    expect(ControllerEnvelope.safeParse(env('snapshotDump', ok)).success).toBe(true);
    expect(SnapshotDumpMsg.safeParse({ type: 'snapshotLs', payload: ok }).success).toBe(false);
  });
});

describe('stream credit / cancel / end', () => {
  it('credit grants 1..64 and round-trips', () => {
    expect(StreamCreditPayload.safeParse({ streamId: ID, grant: 0 }).success).toBe(false);
    expect(StreamCreditPayload.safeParse({ streamId: ID, grant: 65 }).success).toBe(false);
    expect(ControllerEnvelope.safeParse(env('streamCredit', { streamId: ID, grant: 4 })).success).toBe(true);
    expect(StreamCreditMsg.safeParse({ type: 'streamCancel', payload: { streamId: ID, grant: 4 } }).success).toBe(false);
  });
  it('cancel round-trips with or without a reason', () => {
    expect(ControllerEnvelope.safeParse(env('streamCancel', { streamId: ID })).success).toBe(true);
    expect(StreamCancelMsg.safeParse({ type: 'streamCancel', payload: { streamId: 'nope' } }).success).toBe(false);
  });
  it('end is ok with counts, or failed with a stable code', () => {
    expect(StreamEndPayload.safeParse({ streamId: ID, ok: true, bytes: 10, chunks: 1 }).success).toBe(true);
    expect(StreamEndPayload.safeParse({ streamId: ID, ok: false, bytes: 0, error: { code: 'E_TOO_LARGE', message: 'x' } }).success).toBe(true);
    expect(StreamEndPayload.safeParse({ streamId: ID, ok: false, bytes: 0, error: { code: 'E_WHATEVER', message: 'x' } }).success).toBe(false);
    expect(StreamEndPayload.safeParse({ streamId: ID, ok: true, bytes: 10 }).success).toBe(false);
  });
  it('end rides the AGENT envelope only', () => {
    const end = env('streamEnd', { streamId: ID, ok: true, bytes: 1, chunks: 1 });
    expect(AgentEnvelope.safeParse(end).success).toBe(true);
    expect(ControllerEnvelope.safeParse(end).success).toBe(false);
    expect(StreamEndMsg.safeParse({ type: 'streamCredit', payload: end.payload }).success).toBe(false);
  });
});

describe('capabilities', () => {
  it('this agent advertises both snapshot capabilities; an older agent supports neither', () => {
    expect(agentSupports(AGENT_CAPABILITIES, AGENT_CAPABILITY.snapshotLs)).toBe(true);
    expect(agentSupports(AGENT_CAPABILITIES, AGENT_CAPABILITY.snapshotDump)).toBe(true);
    expect(agentSupports(undefined, AGENT_CAPABILITY.snapshotDump)).toBe(false);
    expect(agentSupports(['dbPitrWindow'], AGENT_CAPABILITY.snapshotDump)).toBe(false);
  });
});
