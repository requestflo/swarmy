import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { probeOne, probeSmtp } from './email';

let banner: Server;
let silent: Server;
// Every accepted socket is tracked and destroyed after the suite, and each gets an 'error'
// listener: the probe hangs up abruptly (QUIT then destroy), and an ECONNRESET on a
// listener-less server socket would surface as an unnamed "Unhandled error between tests".
const accepted = new Set<Socket>();
const track = (s: Socket) => {
  accepted.add(s);
  s.on('error', () => undefined);
  s.on('close', () => accepted.delete(s));
};
beforeAll(async () => {
  banner = createServer((s) => {
    track(s);
    s.write('220 mx.test ESMTP ready\r\n');
  });
  silent = createServer(track); // accepts, never speaks
  await Promise.all([banner, silent].map((srv) => new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))));
});
afterAll(async () => {
  for (const s of accepted) s.destroy();
  await Promise.all([banner, silent].map((srv) => new Promise<void>((r) => srv.close(() => r()))));
});

const port = (s: Server) => (s.address() as AddressInfo).port;

describe('probeSmtp handler', () => {
  it('reads the 220 banner and stops at the first answer', async () => {
    const r = await probeSmtp({ commandId: 'c', targets: [{ host: '127.0.0.1', port: port(banner) }, { host: '127.0.0.1', port: port(silent) }], perTargetMs: 1000 });
    expect(r.reachable).toBe(true);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]!.banner).toBe('220 mx.test ESMTP ready');
  });

  it('a silent peer times out; a closed port is refused', async () => {
    expect((await probeOne('127.0.0.1', port(silent), 300)).error?.kind).toBe('timeout');
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const p = port(closed);
    await new Promise<void>((r) => closed.close(() => r()));
    expect((await probeOne('127.0.0.1', p, 1000)).error?.kind).toBe('refused');
  });
});
