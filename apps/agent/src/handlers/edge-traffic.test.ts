import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { EDGE_SCRAPE_CMD, EdgeTrafficScraper, dockerMetricsFetcher } from './edge-traffic';

const body = (shop: number, api: number, e5xx = 0, start = 1.7e9) =>
  `caddy_http_requests_total{handler="subroute",host="shop.test",server="srv0"} ${shop}\n` +
  `caddy_http_requests_total{handler="reverse_proxy",host="shop.test",server="srv0"} ${shop}\n` +
  `caddy_http_requests_total{handler="subroute",host="api.test",server="srv0"} ${api}\n` +
  `caddy_http_request_duration_seconds_count{code="502",handler="subroute",host="shop.test",server="srv0"} ${e5xx}\n` +
  `process_start_time_seconds ${start}\n`;

function harness(bodies: Array<string | undefined | Error>) {
  let t = 1_000_000;
  const scraper = new EdgeTrafficScraper(
    async () => {
      const b = bodies.shift();
      if (b instanceof Error) throw b;
      return b;
    },
    () => t,
  );
  return { scraper, tick: (ms: number) => (t += ms) };
}

describe('EdgeTrafficScraper — deltas on the metrics tick', () => {
  it('baseline first, then per-host deltas; throttled to one scrape per 15 s', async () => {
    const { scraper, tick } = harness([body(100, 10), body(160, 10, 4)]);
    expect(await scraper.sample()).toBeUndefined(); // baseline
    tick(5_000);
    expect(await scraper.sample()).toBeUndefined(); // throttled (no fetch)
    tick(10_000);
    expect(await scraper.sample()).toEqual({
      sampledAt: 1_015_000,
      intervalSec: 15,
      // The duration count carries codes, so shop.test reports zero 403/429 (api.test has none: unreported).
      hosts: [{ host: 'shop.test', requests: 60, errors5xx: 4, status403: 0, status429: 0 }],
    });
  });

  it('adds each host`s 403/429 and duration buckets since the last scrape', async () => {
    const hist = (n200: number, n403: number, n429: number, slow: number) =>
      ['200', '403', '429']
        .map((code, k) => {
          const n = [n200, n403, n429][k]!;
          const l = `code="${code}",handler="subroute",host="shop.test",method="GET",server="srv0"`;
          const fast = code === '200' ? n - slow : n;
          return [
            `caddy_http_request_duration_seconds_bucket{${l},le="0.05"} ${fast}`,
            `caddy_http_request_duration_seconds_bucket{${l},le="1"} ${n}`,
            `caddy_http_request_duration_seconds_bucket{${l},le="+Inf"} ${n}`,
            `caddy_http_request_duration_seconds_count{${l}} ${n}`,
          ].join('\n');
        })
        .join('\n');
    const { scraper, tick } = harness([body(100, 0) + hist(90, 6, 4, 10), body(160, 0) + hist(140, 12, 8, 20)]);
    await scraper.sample();
    tick(15_000);
    expect((await scraper.sample())?.hosts).toEqual([
      { host: 'shop.test', requests: 60, errors5xx: 0, status403: 6, status429: 4, latency: { bounds: [0.05, 1], counts: [50, 10, 0] } },
    ]);
  });

  it('a Caddy restart (new process start time) counts the new totals, never a negative', async () => {
    const { scraper, tick } = harness([body(500, 50), body(20, 5, 0, 1.8e9)]);
    await scraper.sample();
    tick(15_000);
    expect((await scraper.sample())?.hosts).toEqual([
      { host: 'shop.test', requests: 20, errors5xx: 0, status403: 0, status429: 0 },
      { host: 'api.test', requests: 5, errors5xx: 0 },
    ]);
  });

  it('a failed scrape sends nothing and keeps the baseline, so the next delta spans the gap', async () => {
    const { scraper, tick } = harness([body(100, 0), new Error('exec failed'), body(130, 0)]);
    await scraper.sample();
    tick(15_000);
    expect(await scraper.sample()).toBeUndefined();
    tick(15_000);
    expect(await scraper.sample()).toMatchObject({ intervalSec: 30, hosts: [{ host: 'shop.test', requests: 30 }] });
  });

  it('not an edge (no local task) → no edge field, and the baseline is dropped', async () => {
    const { scraper, tick } = harness([body(100, 0), undefined, body(130, 0)]);
    await scraper.sample();
    tick(15_000);
    expect(await scraper.sample()).toBeUndefined();
    tick(15_000);
    expect(await scraper.sample()).toBeUndefined(); // fresh baseline
  });
});

describe('dockerMetricsFetcher — scrape inside the local edge task', () => {
  function fakeDocker(running: Array<{ Id: string }>, stdout: string, exitCode = 0) {
    const calls: Array<{ id: string; cmd: string[] }> = [];
    const filters: unknown[] = [];
    const docker = {
      docker: {
        listContainers: async (o: { filters: unknown }) => {
          filters.push(o.filters);
          return running;
        },
        getContainer: (id: string) => ({
          exec: async (o: { Cmd: string[] }) => {
            calls.push({ id, cmd: o.Cmd });
            return {
              start: async () => {
                const s = new EventEmitter();
                const payload = Buffer.from(stdout);
                const header = Buffer.alloc(8);
                header[0] = 1;
                header.writeUInt32BE(payload.length, 4);
                setTimeout(() => {
                  s.emit('data', Buffer.concat([header, payload]));
                  s.emit('end');
                }, 0);
                return s;
              },
              inspect: async () => ({ ExitCode: exitCode }),
            };
          },
        }),
      },
    };
    return { docker, calls, filters };
  }

  it('finds the task by its swarm service label and reads localhost:2019 over exec (demuxed)', async () => {
    const f = fakeDocker([{ Id: 'c1' }], 'caddy_up 1\n');
    const out = await dockerMetricsFetcher(f.docker as never)();
    expect(out).toBe('caddy_up 1\n');
    expect(f.filters[0]).toEqual({ label: ['com.docker.swarm.service.name=swarmy-ingress-caddy'], status: ['running'] });
    expect(f.calls).toEqual([{ id: 'c1', cmd: EDGE_SCRAPE_CMD }]);
    expect(EDGE_SCRAPE_CMD.at(-1)).toBe('http://127.0.0.1:2019/metrics');
  });

  it('no local edge task → undefined; a non-zero exit throws', async () => {
    expect(await dockerMetricsFetcher(fakeDocker([], '').docker as never)()).toBeUndefined();
    await expect(dockerMetricsFetcher(fakeDocker([{ Id: 'c1' }], '', 1).docker as never)()).rejects.toThrow('exited 1');
  });
});
