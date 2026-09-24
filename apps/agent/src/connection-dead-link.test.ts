import { afterEach, describe, expect, it } from 'bun:test';
import { PROTOCOL_VERSION } from '@swarmy/core/protocol';
import { AgentConnection, linkIsDead, strandedShouldExit } from './connection';

const FAST = { baseMs: 20, maxMs: 50, factor: 2, stableMs: 60_000, dialTimeoutMs: 1_000 };
const ping = (nonce: string) =>
  JSON.stringify({ v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: Date.now(), type: 'ping', payload: { nonce } });

/**
 * A controller double. `blackhole` simulates the lab failure: the controller
 * task dies with the overlay veth NO-CARRIER, so no FIN/RST ever reaches the
 * agent: the socket stays OPEN and simply goes silent.
 */
function controller(mode: { echo: boolean; blackholeAfterFirst?: boolean }) {
  let opens = 0;
  const sockets: Array<{ send(s: string): void }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { headers: { 'sec-websocket-protocol': 'swarmy.v1' } }) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        opens++;
        sockets.push(ws);
        if (mode.echo) ws.send(ping('hb-0')); // proves this controller echoes
      },
      message(ws) {
        // Heartbeat echo; after the first connection, the blackholed one stays silent.
        if (mode.echo && !(mode.blackholeAfterFirst && opens === 1)) ws.send(ping('hb-1'));
      },
    },
  });
  return { server, opens: () => opens, url: `ws://127.0.0.1:${server.port}/agent/ws` };
}

let stopAll: Array<() => void> = [];
afterEach(() => {
  for (const s of stopAll) s();
  stopAll = [];
});

function agent(url: string, extra: Partial<ConstructorParameters<typeof AgentConnection>[0]> = {}) {
  const conn = new AgentConnection({
    url,
    buildRegister: () => ({}) as never,
    onRegisterAck: () => undefined,
    onCommand: () => undefined,
    backoff: FAST,
    idleMs: 150,
    watchdogMs: 25,
    ...extra,
  });
  conn.start();
  stopAll.push(() => conn.stop());
  return conn;
}

describe('agent dead-link detection', () => {
  it('linkIsDead only once the controller has proven it echoes', () => {
    expect(linkIsDead({ armed: false, lastInboundAt: 0, now: 1e9, idleMs: 10 })).toBe(false);
    expect(linkIsDead({ armed: true, lastInboundAt: 100, now: 200, idleMs: 150 })).toBe(false);
    expect(linkIsDead({ armed: true, lastInboundAt: 0, now: 200, idleMs: 150 })).toBe(true);
  });

  it('a silently dead link (open socket, no frames) is dropped and redialed', async () => {
    const c = controller({ echo: true, blackholeAfterFirst: true });
    stopAll.push(() => c.server.stop(true));
    agent(c.url);
    await Bun.sleep(600);
    expect(c.opens()).toBeGreaterThanOrEqual(2); // the agent gave up on the silent socket and came back
  });

  it('a healthy echoing link is kept', async () => {
    const c = controller({ echo: true });
    stopAll.push(() => c.server.stop(true));
    const conn = agent(c.url);
    const beat = setInterval(() => conn.send('heartbeat', { seq: 1, uptimeSec: 1, inflightCommands: 0 }), 40);
    stopAll.push(() => clearInterval(beat));
    await Bun.sleep(500);
    expect(c.opens()).toBe(1);
    expect(conn.connected).toBe(true);
  });

  it('an older controller that never pings is not treated as dead', async () => {
    const c = controller({ echo: false });
    stopAll.push(() => c.server.stop(true));
    agent(c.url);
    await Bun.sleep(500);
    expect(c.opens()).toBe(1);
  });

  it('a link down past strandedMs reports once (the daemon then exits a container agent)', async () => {
    const stranded: number[] = [];
    agent('ws://127.0.0.1:1/agent/ws', { strandedMs: 200, onStranded: (ms) => stranded.push(ms) });
    await Bun.sleep(500);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]!).toBeGreaterThan(200);
  });

  it('only a container agent exits when stranded (overridable)', () => {
    expect(strandedShouldExit('container', undefined)).toBe(true);
    expect(strandedShouldExit('binary', undefined)).toBe(false);
    expect(strandedShouldExit('container', '0')).toBe(false);
    expect(strandedShouldExit('binary', 'true')).toBe(true);
  });
});
