import { describe, expect, test } from 'bun:test';
import { parseWgConnected } from './mesh';

describe('parseWgConnected', () => {
  test('no peers / no handshake → disconnected', () => {
    const dump = 'PRIVKEY\tPUBKEY\t51820\toff';
    expect(parseWgConnected(dump)).toEqual({ connected: false });
  });

  test('a peer with a recent handshake → connected with timestamp', () => {
    // interface line, then a peer line with latest-handshake in column 5 (index 4).
    const ts = 1_750_000_000;
    const dump = ['IFACE_PRIV\tIFACE_PUB\t51820\toff', `PEER_PUB\t(none)\t1.2.3.4:51820\t10.0.0.2/32\t${ts}\t100\t200\t25`].join(
      '\n',
    );
    const out = parseWgConnected(dump);
    expect(out.connected).toBe(true);
    expect(out.lastHandshakeAt).toBe(new Date(ts * 1000).toISOString());
  });

  test('picks the most recent handshake across peers', () => {
    const dump = [
      'IF\tIFP\t51820\toff',
      'P1\t-\t-\t10.0.0.2/32\t1000\t0\t0\t0',
      'P2\t-\t-\t10.0.0.3/32\t2000\t0\t0\t0',
    ].join('\n');
    expect(parseWgConnected(dump).lastHandshakeAt).toBe(new Date(2000 * 1000).toISOString());
  });
});
