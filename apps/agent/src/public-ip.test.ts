import { afterEach, describe, expect, it } from 'bun:test';
import { detectPublicIp, resetPublicIpCache, setObservedPublicIp } from './public-ip';

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
