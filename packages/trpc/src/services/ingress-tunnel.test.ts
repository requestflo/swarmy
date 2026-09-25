import { describe, expect, it } from 'bun:test';
import { tunnelIdFromToken } from './ingress.service';

describe('tunnelIdFromToken', () => {
  it('reads the tunnel id out of a pasted Cloudflare run token', () => {
    const id = '6ff42ae2-765d-4adf-8112-31c55c1551ef';
    const token = Buffer.from(JSON.stringify({ a: 'acct', t: id, s: 'c2VjcmV0' })).toString('base64');
    expect(tunnelIdFromToken(token)).toBe(id);
    expect(tunnelIdFromToken(`  ${token}\n`)).toBe(id);
  });

  it('rejects things that are not tunnel tokens', () => {
    expect(tunnelIdFromToken('not-a-token')).toBeNull();
    expect(tunnelIdFromToken(Buffer.from('{"t":"nope"}').toString('base64'))).toBeNull();
  });
});
