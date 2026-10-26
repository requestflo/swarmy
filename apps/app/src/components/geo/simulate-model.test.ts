import { describe, expect, it } from 'bun:test';
import { simulateWords, type DownSimulation } from './simulate-model';

const LON = '198.51.100.1';
const FRA = '198.51.100.2';
const NYC = '203.0.113.3';
const SGP = '192.0.2.4';
const endpoints = [
  { ip: LON, region: 'eu-west', healthy: true, name: 'london-1' },
  { ip: FRA, region: 'eu-central', healthy: true, name: 'frankfurt-1' },
  { ip: NYC, region: 'us-east', healthy: true, name: 'new-york-1' },
  { ip: SGP, region: 'ap-southeast', healthy: true, name: 'singapore-1' },
];
const places = [
  { id: 'eu', label: 'Europe' },
  { id: 'us', label: 'North America' },
  { id: 'ap', label: 'Asia' },
];

function sim(down: string, regions: DownSimulation['regions'], healthy = true): DownSimulation {
  const e = endpoints.find((x) => x.ip === down)!;
  return { host: 'shop.northwind.dev', ttl: 30, down: { ip: down, region: e.region, healthy }, regions };
}
const r = (from: string, before: string[], after: string[], degraded = false) => ({ from, before, after, degraded, steered: true });

describe('simulateWords — “what if this front door went down?” in plain words', () => {
  it('says who answers each region, and when visitors spill to another region', () => {
    const out = simulateWords(
      sim(LON, [r('eu', [LON, FRA], [FRA, NYC]), r('us', [NYC, LON], [NYC, FRA]), r('ap', [SGP, FRA], [SGP, FRA])]),
      endpoints,
      places,
    );
    expect(out.headline).toBe('If london-1 went down, 1 of 3 regions would move to another front door.');
    expect(out.lines.map((l) => [l.word, l.say])).toEqual([
      ['moves', 'Europe would be answered by frankfurt-1 and new-york-1.'],
      ['keeps', 'North America keeps new-york-1; frankfurt-1 becomes its fallback.'],
      ['unchanged', 'Asia keeps singapore-1 and frankfurt-1.'],
    ]);
    expect(out.timing).toBe('Visitors already holding london-1’s address move within about 45 seconds: swarmy notices in 15, then their 30-second answer runs out.');
  });

  it('spills a region whose nearest front door leaves its part of the world', () => {
    const out = simulateWords(sim(SGP, [r('ap', [SGP, FRA], [FRA, LON])]), endpoints, places);
    expect(out.lines[0]!.word).toBe('spills');
    expect(out.lines[0]!.say).toBe('Asia would spill to frankfurt-1 and london-1.');
  });

  it('says plainly when nothing healthy would be left', () => {
    const out = simulateWords(sim(NYC, [r('us', [NYC], [NYC], true)]), endpoints, places);
    expect(out.headline).toBe('If new-york-1 went down, no front door would be left healthy, so swarmy would answer with all of them.');
    expect(out.lines[0]!.word).toBe('everyone');
  });

  it('an edge that is already down shows what visitors get now', () => {
    const out = simulateWords(sim(SGP, [r('ap', [FRA, LON], [FRA, LON])], false), endpoints, places);
    expect(out.headline).toBe('singapore-1 is already out of the answers, so this is what visitors get now.');
  });
});
