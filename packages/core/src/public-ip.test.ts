import { describe, expect, it } from 'bun:test';
import { isPublicIpv4, observedPublicIpv4 } from './public-ip';

describe('isPublicIpv4', () => {
  it('accepts public addresses', () => {
    for (const ip of ['203.0.113.7', '8.8.8.8', '165.227.1.2']) expect(isPublicIpv4(ip)).toBe(true);
  });
  it('rejects private, loopback, CGNAT, link-local, multicast and junk', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.5.5', '192.168.1.1', '100.64.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '1.2.3', '300.1.1.1', '', undefined]) {
      expect(isPublicIpv4(ip)).toBe(false);
    }
  });
});

describe('observedPublicIpv4', () => {
  it('unwraps IPv4-mapped socket addresses', () => {
    expect(observedPublicIpv4('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(observedPublicIpv4('::ffff:10.0.0.2')).toBeUndefined();
    expect(observedPublicIpv4('2001:db8::1')).toBeUndefined();
  });
});

import { DEFAULT_PUBLIC_IP_ECHO, parsePublicIpEcho } from './public-ip';

describe('parsePublicIpEcho (SWARMY_PUBLIC_IP_ECHO)', () => {
  it('defaults when unset, disables on empty/off/none', () => {
    expect(parsePublicIpEcho(undefined)).toEqual([...DEFAULT_PUBLIC_IP_ECHO]);
    expect(parsePublicIpEcho('')).toEqual([]);
    expect(parsePublicIpEcho('off')).toEqual([]);
    expect(parsePublicIpEcho('none')).toEqual([]);
  });
  it('takes a comma list of URLs, drops junk', () => {
    expect(parsePublicIpEcho('https://ip.example.com, nonsense ,http://10.0.0.1/ip')).toEqual([
      'https://ip.example.com',
      'http://10.0.0.1/ip',
    ]);
  });
});
