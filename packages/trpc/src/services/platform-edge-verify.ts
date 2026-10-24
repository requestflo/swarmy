/**
 * Verify, edge leg (plans/epic-platform-upgrades.md §2.5: "a synthetic
 * request through every edge"). After an upgrade the edges are back as
 * services, but that doesn't prove they route: each edge node gets one HTTP
 * request to a route swarmy itself serves — the controller's own address (the
 * dashboard vhost every edge carries), `GET /health` — sent from the edge
 * node to its own Caddy (`--resolve <host>:443:127.0.0.1`, host network), so
 * NAT hairpins and public DNS don't decide the answer. Pass = HTTP 200 with
 * the controller's health body. Any edge that keeps failing fails Verify.
 *
 * TLS is not judged here (`-k`): a `tls internal` or private-CA edge is still
 * a working edge. Pure apart from {@link edgeVerifyIO}.
 */
import type { RunOnceResult } from '@swarmy/core/protocol';
import { systemImage } from '@swarmy/core/system-images';
import type { OrgContext } from '../context';
import { ingressTaskNodes } from './ingress-controller';
import { dashboardDomainFor, orgDashboardDomain } from './ingress.service';

export const EDGE_MARKER = '@@SWARMY-EDGE@@';
export const EDGE_HEALTH_PATH = '/health';

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The one-shot an edge node runs: a request through its own Caddy. Prints the marker line last. Pure. */
export function edgeProbeScript(host: string): string {
  return [
    'set -u',
    `B=$(curl -sk --max-time 10 --resolve ${sq(`${host}:443:127.0.0.1`)} -w '\\n%{http_code}' ${sq(`https://${host}${EDGE_HEALTH_PATH}`)} 2>/dev/null); RC=$?`,
    `CODE=$(printf '%s' "$B" | tail -n 1)`,
    `case "$B" in *swarmy-controller*) OK=1 ;; *) OK=0 ;; esac`,
    `echo "${EDGE_MARKER} $RC \${CODE:-000} $OK"`,
  ].join('\n');
}

export interface EdgeProbe {
  /** curl's exit code (-1 = no marker: the one-shot itself failed). */
  rc: number;
  code: number;
  /** The body was the controller's health answer (not a placeholder page). */
  controller: boolean;
}

export function parseEdgeProbe(output: string): EdgeProbe {
  const line = output
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(EDGE_MARKER));
  if (!line) return { rc: -1, code: 0, controller: false };
  const [, rc, code, ok] = line.trim().split(/\s+/);
  return { rc: Number(rc ?? -1), code: Number(code ?? 0) || 0, controller: ok === '1' };
}

export function edgeProbeOk(p: EdgeProbe): boolean {
  return p.rc === 0 && p.code === 200 && p.controller;
}

/** "node-2: no answer from its edge (curl exit 7)". Pure. */
export function edgeProblem(name: string, p: EdgeProbe): string {
  if (p.rc === -1) return `${name}: the test request could not run there`;
  if (p.rc !== 0) return `${name}: no answer from its edge (curl exit ${p.rc})`;
  if (p.code !== 200) return `${name}: its edge answered HTTP ${p.code}, not the controller`;
  return `${name}: its edge answered, but not with the controller's health check`;
}

export interface EdgeVerifyIO {
  /** The swarmy-served host every edge carries, or null when the edges have none. */
  host: () => Promise<string | null>;
  /** Servers running an edge task right now. */
  edges: () => Promise<Array<{ nodeId: string; name: string }>>;
  /** Run the probe script on one server → its output. */
  probe: (nodeId: string, script: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface EdgeVerifyReport {
  checked: string[];
  /** Why no edge was tested (no edge, or no swarmy address on them). */
  skipped?: string;
}

/** Probe every edge; retry the failing ones until `deadlineMs`, then throw with each one's reason. */
export async function verifyEdges(io: EdgeVerifyIO, opts: { deadlineMs?: number; pollMs?: number } = {}): Promise<EdgeVerifyReport> {
  const host = await io.host();
  if (!host) return { checked: [], skipped: 'the edges carry no swarmy address to test (no dashboard domain)' };
  const edges = await io.edges();
  if (!edges.length) return { checked: [], skipped: 'no swarmy edge runs in this cluster' };
  const deadline = io.now() + (opts.deadlineMs ?? 3 * 60_000);
  const script = edgeProbeScript(host);
  let failing = edges;
  for (;;) {
    const problems: string[] = [];
    const still: typeof edges = [];
    for (const e of failing) {
      const p = parseEdgeProbe(await io.probe(e.nodeId, script).catch(() => ''));
      if (edgeProbeOk(p)) continue;
      still.push(e);
      problems.push(edgeProblem(e.name, p));
    }
    if (!still.length) return { checked: edges.map((e) => e.name) };
    if (io.now() > deadline) throw new Error(`a request to ${host} through the edges did not reach the controller — ${problems.join('; ')}`);
    failing = still;
    await io.sleep(opts.pollMs ?? 10_000);
  }
}

/** The real IO: the dashboard vhost, the nodes hosting a Caddy task, a curl one-shot on each. */
export function edgeVerifyIO(ctx: OrgContext, sleep: (ms: number) => Promise<void>, now: () => number): EdgeVerifyIO {
  return {
    host: async () => dashboardDomainFor({ dashboardDomain: await orgDashboardDomain(ctx) }),
    edges: async () => {
      const ids = await ingressTaskNodes(ctx);
      const names = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId, id: { in: ids } }, select: { id: true, name: true } });
      return ids.map((id) => ({ nodeId: id, name: names.find((n) => n.id === id)?.name ?? id }));
    },
    probe: async (nodeId, script) => {
      const payload = { image: systemImage('curl').ref, entrypoint: ['/bin/sh', '-c'], cmd: [script], networks: ['host'], timeoutMs: 30_000 };
      return (await ctx.hub.dispatch<RunOnceResult>(nodeId, 'container.runOnce', payload, { timeoutMs: 60_000 })).output ?? '';
    },
    sleep,
    now,
  };
}
