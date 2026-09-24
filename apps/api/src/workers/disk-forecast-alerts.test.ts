import { describe, expect, it } from 'bun:test';
import { forecastConditions, forecastSuggestion, type ForecastNode } from './disk-forecast-alerts';

const GB = 1024 ** 3;
const H = 3_600_000;
const NOW = 1_800_000_000_000;

function node(name: string, perDayGb: number, startGb: number, extra: Partial<ForecastNode> = {}): ForecastNode {
  return {
    name,
    swarmNodeId: `sw-${name}`,
    schedulable: true,
    series: Array.from({ length: 49 }, (_, i) => ({
      ts: NOW - (48 - i) * H,
      usedBytes: (startGb + (i / 24) * perDayGb) * GB,
      totalBytes: 100 * GB,
    })),
    ...extra,
  };
}

describe('forecastConditions', () => {
  it('fires a warning for a disk filling within two weeks, with a concrete move', () => {
    const nodes = [node('fra-1', 2, 70), node('hel-1', 0, 20)];
    const services = [{ name: 'shop_db-primary', labels: { 'swarmy.db.node': 'sw-fra-1' } }];
    const out = forecastConditions(nodes, services, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.signal).toBe('disk-usage');
    expect(out[0]!.resource).toBe('node:fra-1:forecast');
    expect(out[0]!.severity).toBe('warning');
    expect(out[0]!.message).toContain('fills up in about 13 days');
    expect(out[0]!.message).toContain('move shop_db-primary to hel-1, which has 65 GB free');
  });

  it('critical inside three days; stable disks never fire', () => {
    const out = forecastConditions([node('a', 5, 88), node('b', 0, 50)], [], NOW);
    expect(out.map((c) => [c.resource, c.severity])).toEqual([['node:a:forecast', 'critical']]);
  });

  it('the live sample extends the series', () => {
    const n = node('a', 0, 50, { live: { usedBytes: 99 * GB, totalBytes: 100 * GB } });
    expect(forecastConditions([n], [], NOW)[0]!.severity).toBe('critical');
  });
});

describe('forecastSuggestion', () => {
  it('no pinned data → suggest retiring onto the roomiest server; no other server → disk only', () => {
    expect(forecastSuggestion(node('a', 1, 50), [node('a', 1, 50), node('b', 0, 10)], [])).toBe(
      'Next step: add a disk to a (attach a volume at your provider; swarmy offers to use it), or retire a and let swarmy move its apps to b.',
    );
    expect(forecastSuggestion(node('a', 1, 50), [node('a', 1, 50)], [])).toBe(
      'Next step: add a disk to a (attach a volume at your provider; swarmy offers to use it).',
    );
  });
});
