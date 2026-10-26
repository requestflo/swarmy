import { describe, expect, test } from 'bun:test';
import { endWords, estateLabel, fmtMs, latencyWords, linkPath, mapLabel, nearestLink, pairKey, type LinkEndLike, type MeshLinkLike } from './mesh-link-words';

const end = (latencyMs: number | null, relayed: boolean | null, rx: number | null = null, tx: number | null = null): LinkEndLike => ({
  latencyMs,
  relayed,
  rxBytes: rx,
  txBytes: tx,
});
const link = (a: string, b: string, ab: LinkEndLike | null, ba: LinkEndLike | null = null): MeshLinkLike => ({ a, b, ab, ba });

describe('mesh link words', () => {
  test('latency reads like the boards: 0.4 ms, 4.2 ms, 11 ms', () => {
    expect(fmtMs(0.412)).toBe('0.4 ms');
    expect(fmtMs(4)).toBe('4 ms');
    expect(fmtMs(4.25)).toBe('4.3 ms');
    expect(fmtMs(11.4)).toBe('11 ms');
    expect(fmtMs(0.02)).toBe('<0.1 ms');
  });

  test('both ends reported: one number when they agree, a range when they differ; none = null', () => {
    expect(latencyWords(link('a', 'b', end(11.2, false), end(10.9, false)))).toBe('11 ms');
    expect(latencyWords(link('a', 'b', end(11, false), end(12.6, false)))).toBe('11–13 ms');
    expect(latencyWords(link('a', 'b', end(null, false)))).toBeNull();
    expect(latencyWords(link('a', 'b', null, null))).toBeNull();
  });

  test('path: relayed when either end says so; direct when an end says peer to peer; else unknown', () => {
    expect(linkPath(link('a', 'b', end(19, true), end(18, false)))).toBe('relayed');
    expect(linkPath(link('a', 'b', null, end(1, false)))).toBe('direct');
    expect(linkPath(link('a', 'b', end(1, null)))).toBeNull();
  });

  test('map and estate labels', () => {
    expect(mapLabel(link('a', 'b', end(0.4, false)))).toBe('0.4 ms');
    expect(mapLabel(link('a', 'b', end(19, true)))).toBe('through the relay · 19 ms');
    expect(mapLabel(link('a', 'b', end(null, true)))).toBe('through the relay');
    expect(mapLabel(link('a', 'b', end(null, false)))).toBeNull();
    expect(estateLabel(link('a', 'b', end(11, false)))).toBe('direct · 11 ms');
    expect(estateLabel(link('a', 'b', end(19, true)))).toBe('relayed · 19 ms');
    expect(estateLabel(link('a', 'b', end(null, false)))).toBeNull();
  });

  test('one end as a tech line, or "not reported" for an older agent', () => {
    expect(endWords(end(0.4, false, 1288490188, 356515840))).toBe('0.4 ms · direct · ↓ 1.2 GB ↑ 340 MB');
    expect(endWords(end(null, true, 1024, null))).toBe('relayed · ↓ 1.0 KB ↑ —');
    expect(endWords(null)).toBe('not reported');
    expect(endWords(end(null, null))).toBe('reported, nothing measured yet');
  });

  test('a new server\'s nearest link: the lowest round trip, else any with a known path', () => {
    const links = [link('n-home', 'n-pi', end(0.4, false)), link('n-lon-1', 'n-pi', end(11, false), end(12, false)), link('n-lon-2', 'n-x', end(1, false))];
    expect(nearestLink(links, 'n-pi')).toEqual({ other: 'n-home', path: 'direct', latency: '0.4 ms' });
    expect(nearestLink([link('n-a', 'n-b', end(null, true))], 'n-b')).toEqual({ other: 'n-a', path: 'relayed', latency: null });
    expect(nearestLink(links, 'n-none')).toBeNull();
    expect(pairKey('b', 'a')).toBe('a~b');
  });
});
