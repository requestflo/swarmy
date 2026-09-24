import { describe, expect, it } from 'bun:test';
import { publicIpToStamp } from './node.service';

describe('publicIpToStamp (B8: controller view before echo services)', () => {
  it("uses the agent's report when it is public", () => {
    expect(publicIpToStamp('203.0.113.7', '::ffff:198.51.100.1')).toBe('203.0.113.7');
  });
  it('falls back to the public WSS source address when the agent reports nothing', () => {
    expect(publicIpToStamp(undefined, '::ffff:198.51.100.1')).toBe('198.51.100.1');
  });
  it('never stamps a private / loopback / mesh source', () => {
    expect(publicIpToStamp(undefined, '10.0.1.5')).toBeUndefined();
    expect(publicIpToStamp(undefined, '127.0.0.1')).toBeUndefined();
    expect(publicIpToStamp(undefined, '100.101.0.3')).toBeUndefined();
    expect(publicIpToStamp('192.168.1.2', undefined)).toBeUndefined();
  });
});
