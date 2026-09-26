import { afterEach, describe, expect, it } from 'bun:test';
import { classifyReachability, detectPublicIp, resetPublicIpCache, setObservedPublicIp } from './public-ip';

const echo = (body: string, calls: string[]) => async (url: string) => {
  calls.push(url);
  return { ok: true, text: async () => body };
};

afterEach(() => resetPublicIpCache());

describe('detectPublicIp — controller view first, echo last', () => {
  it('uses the controller-observed IP and never calls an echo service', async () => {
    const calls: string[] = [];
    setObservedPublicIp('203.0.113.7');
    expect(await detectPublicIp({ providers: ['https://echo.example'], fetchImpl: echo('198.51.100.9', calls) })).toBe(
      '203.0.113.7',
    );
    expect(calls).toEqual([]);
  });
  it('ignores a non-public observed address and falls back to echo', async () => {
    const calls: string[] = [];
    setObservedPublicIp('10.0.0.4');
    expect(await detectPublicIp({ providers: ['https://echo.example'], fetchImpl: echo('198.51.100.9', calls) })).toBe(
      '198.51.100.9',
    );
    expect(calls).toEqual(['https://echo.example']);
  });
  it('with echo disabled (SWARMY_PUBLIC_IP_ECHO=off) and no controller view, returns undefined', async () => {
    expect(await detectPublicIp({ providers: [] })).toBeUndefined();
  });
});

describe('classifyReachability (QA-084)', () => {
  const lan = ['127.0.0.1', '192.168.5.15', '100.106.145.62'];
  it('public IP on an interface → public', () => {
    expect(classifyReachability({ publicIp: '203.0.113.7', hostAddresses: ['127.0.0.1', '203.0.113.7'], dmi: ['QEMU'] })).toBe('public');
  });
  it('a home VM (public IP is the router’s) → nat', () => {
    expect(classifyReachability({ publicIp: '81.2.69.160', hostAddresses: lan, dmi: ['QEMU', 'Standard PC (Q35 + ICH9, 2009)'] })).toBe('nat');
  });
  it('1:1-NAT clouds (EC2, GCE, Azure) → public', () => {
    for (const dmi of [['Amazon EC2'], ['Google', 'Google Compute Engine'], ['Microsoft Corporation', '7783-7084-3265-9085-8269-3286-77']]) {
      expect(classifyReachability({ publicIp: '203.0.113.7', hostAddresses: ['10.0.0.4'], dmi })).toBe('public');
    }
  });
  it('can’t tell → undefined (never nat)', () => {
    expect(classifyReachability({ publicIp: undefined, hostAddresses: lan, dmi: [] })).toBeUndefined();
    expect(classifyReachability({ publicIp: '203.0.113.7', hostAddresses: null, dmi: [] })).toBeUndefined();
  });
});
