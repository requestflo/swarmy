import { afterEach, describe, expect, it } from 'bun:test';
import { PROTOCOL_VERSION } from '@swarmy/core/protocol';
import { AgentConnection, MAX_DROPPED_COMMANDS, describeDroppedFrame } from './connection';
import { bareMeshIp } from './handlers/mesh';

/** QA-063: an unreadable command used to vanish (no log, no result) and the controller timed out 6/6. */
const frame = (type: string, payload: unknown) =>
  JSON.stringify({ v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: Date.now(), type, payload });
const badJoin = () =>
  frame('swarmJoin', {
    commandId: crypto.randomUUID(),
    mode: 'join',
    joinToken: 'SWMTKN-1-x',
    managerAddr: '100.106.0.1:2377',
    advertiseAddr: '', // what an addressed-later mesh IP used to produce
  });

describe('describeDroppedFrame', () => {
  it('names the type, the commandId and the exact field for a schema mismatch', () => {
    const d = describeDroppedFrame(badJoin());
    expect(d?.type).toBe('swarmJoin');
    expect(d?.commandId).toMatch(/[0-9a-f-]{36}/);
    expect(d?.reason).toContain('payload.advertiseAddr');
  });

  it('a readable frame is not dropped; garbage is, with no commandId', () => {
    expect(describeDroppedFrame(frame('ping', { nonce: 'n1' }))).toBeNull();
    expect(describeDroppedFrame('{not json')).toMatchObject({ type: '(unknown)' });
    expect(describeDroppedFrame('{not json')?.commandId).toBeUndefined();
  });
});

describe('bareMeshIp', () => {
  it("'' (connected, not yet addressed) is no address", () => {
    expect(bareMeshIp('')).toBeUndefined();
    expect(bareMeshIp(undefined)).toBeUndefined();
    expect(bareMeshIp('100.106.1.2/16')).toBe('100.106.1.2');
  });
});

let stopAll: Array<() => void> = [];
afterEach(() => {
  for (const s of stopAll) s();
  stopAll = [];
});

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`condition not met within ${ms} ms`);
    await Bun.sleep(20);
  }
}

describe('AgentConnection with unreadable commands', () => {
  it('answers each with a failed result naming the reason, then redials after MAX_DROPPED_COMMANDS', async () => {
    let opens = 0;
    const results: Array<{ status: string; error?: { code: string; message: string } }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req, { headers: { 'sec-websocket-protocol': 'swarmy.v1' } }) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open() {
          opens++;
        },
        message(ws, msg) {
          const m = JSON.parse(String(msg)) as { type: string; payload: never };
          if (m.type === 'register' && opens === 1) for (let i = 0; i < MAX_DROPPED_COMMANDS; i++) ws.send(badJoin());
          if (m.type === 'commandResult') results.push(m.payload);
        },
      },
    });
    stopAll.push(() => server.stop(true));
    const conn = new AgentConnection({
      url: `ws://127.0.0.1:${server.port}/agent/ws`,
      buildRegister: () => ({}) as never,
      onRegisterAck: () => undefined,
      onCommand: () => {
        throw new Error('an unreadable frame must never reach the executor');
      },
      backoff: { baseMs: 20, maxMs: 50, factor: 2, stableMs: 60_000, dialTimeoutMs: 1_000 },
      watchdogMs: 1_000,
    });
    conn.start();
    stopAll.push(() => conn.stop());

    await waitFor(() => opens >= 2, 3_000);
    expect(results).toHaveLength(MAX_DROPPED_COMMANDS);
    for (const r of results) {
      expect(r.status).toBe('failed');
      expect(r.error?.code).toBe('E_MALFORMED');
      expect(r.error?.message).toContain('payload.advertiseAddr');
    }
  });

  it('a readable command in between resets the count — no redial', async () => {
    let opens = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req, { headers: { 'sec-websocket-protocol': 'swarmy.v1' } }) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open() {
          opens++;
        },
        message(ws, msg) {
          if ((JSON.parse(String(msg)) as { type: string }).type !== 'register') return;
          for (let i = 0; i < MAX_DROPPED_COMMANDS - 1; i++) ws.send(badJoin());
          ws.send(frame('ping', { nonce: 'cmd-1' }));
          for (let i = 0; i < MAX_DROPPED_COMMANDS - 1; i++) ws.send(badJoin());
        },
      },
    });
    stopAll.push(() => server.stop(true));
    let handled = 0;
    const conn = new AgentConnection({
      url: `ws://127.0.0.1:${server.port}/agent/ws`,
      buildRegister: () => ({}) as never,
      onRegisterAck: () => undefined,
      onCommand: () => void handled++,
      backoff: { baseMs: 20, maxMs: 50, factor: 2, stableMs: 60_000, dialTimeoutMs: 1_000 },
      watchdogMs: 1_000,
    });
    conn.start();
    stopAll.push(() => conn.stop());
    await waitFor(() => handled === 1, 3_000);
    await Bun.sleep(200);
    expect(opens).toBe(1);
  });
});
