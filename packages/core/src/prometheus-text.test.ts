import { describe, expect, it } from 'bun:test';
import { parsePrometheusLine, parsePrometheusText } from './prometheus-text';

const GOLDEN = `# HELP caddy_http_requests_total Counter of HTTP(S) requests made.
# TYPE caddy_http_requests_total counter
caddy_http_requests_total{handler="subroute",host="shop.example.com",server="srv0"} 1520
caddy_http_requests_total{handler="reverse_proxy",host="shop.example.com",server="srv0"} 1500

# a stray comment
go_goroutines 42
process_start_time_seconds 1.7000000005e+09
weird_metric{path="C:\\\\tmp",msg="say \\"hi\\"\\nbye"} -3.5 1700000000000
not a metric line
caddy_up NaN
caddy_limit +Inf
`;

describe('parsePrometheusText — golden Caddy exposition', () => {
  it('parses labelled and bare samples, skipping comments, blanks and junk', () => {
    const samples = parsePrometheusText(GOLDEN);
    expect(samples.map((s) => s.name)).toEqual([
      'caddy_http_requests_total',
      'caddy_http_requests_total',
      'go_goroutines',
      'process_start_time_seconds',
      'weird_metric',
      'caddy_up',
      'caddy_limit',
    ]);
    expect(samples[0]).toEqual({
      name: 'caddy_http_requests_total',
      labels: { handler: 'subroute', host: 'shop.example.com', server: 'srv0' },
      value: 1520,
    });
    expect(samples[2]).toEqual({ name: 'go_goroutines', labels: {}, value: 42 });
    expect(samples[3]!.value).toBe(1_700_000_000.5);
  });

  it('unescapes label values and ignores a trailing timestamp', () => {
    const s = parsePrometheusText(GOLDEN).find((x) => x.name === 'weird_metric')!;
    expect(s.labels).toEqual({ path: 'C:\\tmp', msg: 'say "hi"\nbye' });
    expect(s.value).toBe(-3.5);
  });

  it('reads NaN and +Inf', () => {
    const all = parsePrometheusText(GOLDEN);
    expect(Number.isNaN(all.find((x) => x.name === 'caddy_up')!.value)).toBe(true);
    expect(all.find((x) => x.name === 'caddy_limit')!.value).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects malformed lines instead of guessing', () => {
    expect(parsePrometheusLine('x{a="b"')).toBeUndefined();
    expect(parsePrometheusLine('x{a=b} 1')).toBeUndefined();
    expect(parsePrometheusLine('x 12abc')).toBeUndefined();
    expect(parsePrometheusLine('x')).toBeUndefined();
    expect(parsePrometheusLine('x{} 7')).toEqual({ name: 'x', labels: {}, value: 7 });
    expect(parsePrometheusLine('x{a="1",} 7')).toEqual({ name: 'x', labels: { a: '1' }, value: 7 });
  });
});
