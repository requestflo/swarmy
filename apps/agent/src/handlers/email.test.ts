import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { probeOne, probeSmtp } from './email';

let banner: Server;
let silent: Server;
beforeAll(async () => {
  banner = createServer((s) => s.write('220 mx.test ESMTP ready\r\n'));
  silent = createServer(() => undefined); // accepts, never speaks
  await Promise.all([banner, silent].map((srv) => new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))));
});
afterAll(() => {
  banner.close();
  silent.close();
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
    closed.close();
    expect((await probeOne('127.0.0.1', p, 1000)).error?.kind).toBe('refused');
  });
});
