import {
  caddyHostCounters,
  edgeTrafficDelta,
  parsePrometheusText,
  processStartTime,
  type EdgeScrapeState,
} from '@swarmy/core';
import type { DockerClient } from '@swarmy/core/docker';
import type { EdgeTrafficSample } from '@swarmy/core/protocol';
import { createLogDemuxer } from '../log-demux';

/**
 * Per-edge request counting (Q4). On a node running the swarmy edge Caddy,
 * read Caddy's Prometheus `/metrics` from INSIDE the local task (exec over
 * the docker socket, like `localReload`): the admin listener stays on the
 * task's localhost and port 2019 is never published. The per-host counter
 * deltas since the previous scrape ride the existing `metrics` frame as its
 * optional `edge` field.
 *
 * Scrapes run on the metrics tick but at most every {@link EDGE_SCRAPE_MIN_MS}
 * — each one is a docker exec, and 15 s is plenty for per-minute rates. A
 * node without a running edge task, or a failed scrape, sends no `edge` field
 * (never a fake zero); the baseline is kept, so the next good scrape's delta
 * still covers the gap.
 */
export const EDGE_CADDY_SERVICE = 'swarmy-ingress-caddy';
export const EDGE_METRICS_URL = 'http://127.0.0.1:2019/metrics';
export const EDGE_SCRAPE_MIN_MS = 15_000;
/** busybox wget ships in caddy:*-alpine and the caddy-swarmy image. */
export const EDGE_SCRAPE_CMD = ['wget', '-q', '-T', '5', '-O', '-', EDGE_METRICS_URL];

/** Reads the local edge task's metrics body; undefined when no edge task runs here. */
export type MetricsFetcher = () => Promise<string | undefined>;

export class EdgeTrafficScraper {
  private prev: EdgeScrapeState | undefined;
  private lastAttempt = 0;

  constructor(
    private readonly fetchMetrics: MetricsFetcher,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = EDGE_SCRAPE_MIN_MS,
  ) {}

  /** The `metrics.edge` payload for this tick, or undefined (not an edge / throttled / baseline / failed). */
  async sample(): Promise<EdgeTrafficSample | undefined> {
    const at = this.now();
    if (at - this.lastAttempt < this.minIntervalMs) return undefined;
    this.lastAttempt = at;
    let body: string | undefined;
    try {
      body = await this.fetchMetrics();
    } catch {
      return undefined; // keep the baseline; the next good scrape covers the gap
    }
    if (body === undefined) {
      // Not (or no longer) an edge: forget the baseline so a later edge task starts clean.
      this.prev = undefined;
      return undefined;
    }
    const samples = parsePrometheusText(body);
    const curr: EdgeScrapeState = { at, counters: caddyHostCounters(samples) };
    const startedAt = processStartTime(samples);
    if (startedAt !== undefined) curr.startedAt = startedAt;
    const delta = edgeTrafficDelta(this.prev, curr);
    this.prev = curr;
    return delta;
  }
}

/** Exec the scrape inside this node's running edge Caddy task; undefined when none runs here. */
export function dockerMetricsFetcher(docker: DockerClient): MetricsFetcher {
  return async () => {
    const containers = await docker.docker.listContainers({
      filters: { label: [`com.docker.swarm.service.name=${EDGE_CADDY_SERVICE}`], status: ['running'] },
    });
    const target = containers[0];
    if (!target) return undefined;
    const exec = await docker.docker
      .getContainer(target.Id)
      .exec({ Cmd: EDGE_SCRAPE_CMD, AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({});
    let out = '';
    const demux = createLogDemuxer((name, text) => {
      if (name === 'stdout') out += text;
    });
    await new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => demux(chunk));
      stream.on('end', () => resolve());
      stream.on('error', () => resolve());
    });
    const inspect = await exec.inspect();
    if (inspect.ExitCode !== 0) throw new Error(`edge metrics scrape exited ${inspect.ExitCode}`);
    return out;
  };
}
