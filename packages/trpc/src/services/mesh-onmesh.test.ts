import { describe, expect, it } from 'bun:test';
import { isMeshCidr, isOnMesh } from './mesh-onmesh';

describe('isOnMesh', () => {
  it('matches the node’s own mesh IP or any 100.64/10 address', () => {
    expect(isOnMesh('100.92.0.11:2377', null)).toBe(true);
    expect(isOnMesh('10.0.0.5:2377', '10.0.0.5')).toBe(true);
    expect(isOnMesh('192.168.1.4:2377', '100.92.0.11')).toBe(false);
    expect(isOnMesh(null, '100.92.0.11')).toBe(false);
  });
  it('bounds the CGNAT range', () => {
    expect(isMeshCidr('100.63.255.255')).toBe(false);
    expect(isMeshCidr('100.64.0.1')).toBe(true);
    expect(isMeshCidr('100.128.0.1')).toBe(false);
  });
});
