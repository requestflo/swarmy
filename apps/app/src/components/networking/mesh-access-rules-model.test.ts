import { describe, expect, it } from 'bun:test';
import { parsePorts, rulesCount } from './mesh-access-rules-model';

describe('mesh access rules (Mesh settings)', () => {
  it('reads a port list the way people type it', () => {
    expect(parsePorts('5432, 6379')).toEqual([5432, 6379]);
    expect(parsePorts(' 22 443  443 ')).toEqual([22, 443]);
    expect(parsePorts('')).toEqual([]);
    expect(parsePorts('80-90')).toBe("80-90 isn't a port: use numbers like 5432, 6379");
    expect(parsePorts('0')).toBe("0 isn't a port (1 to 65535)");
  });

  it('counts the rules, naming the ones swarmy keeps', () => {
    expect(rulesCount([])).toBe('0 rules');
    expect(rulesCount([{ managedBySwarmy: false }])).toBe('1 rule');
    expect(rulesCount([{ managedBySwarmy: true }, { managedBySwarmy: false }, { managedBySwarmy: true }])).toBe('3 rules · 2 kept by swarmy');
  });
});
