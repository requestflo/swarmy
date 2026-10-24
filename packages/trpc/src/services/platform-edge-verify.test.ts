import { describe, expect, it } from 'bun:test';
import { EDGE_MARKER, edgeProbeOk, edgeProbeScript, edgeProblem, parseEdgeProbe, verifyEdges, type EdgeVerifyIO } from './platform-edge-verify';

const OK = `${EDGE_MARKER} 0 200 1`;

function io(answers: Record<string, string[]>, over: Partial<EdgeVerifyIO> = {}) {
  let t = 0;
  const probes: string[] = [];
  const x: EdgeVerifyIO = {
    host: async () => 'swarmy.example.com',
    edges: async () => Object.keys(answers).map((id) => ({ nodeId: id, name: `node-${id}` })),
    probe: async (id) => {
      probes.push(id);
      const a = answers[id]!;
      return (a.length > 1 ? a.shift() : a[0]) ?? ''; // the last answer repeats
    },
    sleep: async (ms) => void (t += ms),
    now: () => t,
    ...over,
  };
  return { io: x, probes };
}

describe('edge probe script + parse', () => {
  it("asks the edge's own Caddy for the controller's health, by its public name, without judging TLS", () => {
    const s = edgeProbeScript('swarmy.example.com');
    expect(s).toContain(`--resolve 'swarmy.example.com:443:127.0.0.1'`);
    expect(s).toContain(`'https://swarmy.example.com/health'`);
    expect(s).toContain('curl -sk');
    expect(s.split('\n').at(-1)).toContain(EDGE_MARKER);
  });

  it('passes only on HTTP 200 with the controller body; says why otherwise', () => {
    expect(edgeProbeOk(parseEdgeProbe(`noise\n${OK}\n`))).toBe(true);
    const placeholder = parseEdgeProbe(`${EDGE_MARKER} 0 200 0`);
    expect(edgeProbeOk(placeholder)).toBe(false);
    expect(edgeProblem('node-2', placeholder)).toMatch(/not with the controller's health check/);
    expect(edgeProblem('node-2', parseEdgeProbe(`${EDGE_MARKER} 0 502 0`))).toBe('node-2: its edge answered HTTP 502, not the controller');
    expect(edgeProblem('node-2', parseEdgeProbe(`${EDGE_MARKER} 7 000 0`))).toBe('node-2: no answer from its edge (curl exit 7)');
    expect(parseEdgeProbe('the one-shot crashed')).toEqual({ rc: -1, code: 0, controller: false });
  });
});

describe('verifyEdges', () => {
  it('every edge answers → checked, one request each', async () => {
    const w = io({ a: [OK], b: [OK] });
    expect(await verifyEdges(w.io)).toEqual({ checked: ['node-a', 'node-b'] });
    expect(w.probes).toEqual(['a', 'b']);
  });

  it('an edge still warming up is retried alone until it answers', async () => {
    const w = io({ a: [OK], b: [`${EDGE_MARKER} 7 000 0`, OK] });
    expect((await verifyEdges(w.io, { pollMs: 5_000 })).checked).toEqual(['node-a', 'node-b']);
    expect(w.probes).toEqual(['a', 'b', 'b']);
  });

  it('an edge that keeps failing fails Verify with its reason', async () => {
    const w = io({ a: [OK], b: [`${EDGE_MARKER} 0 502 0`] });
    await expect(verifyEdges(w.io, { deadlineMs: 30_000, pollMs: 10_000 })).rejects.toThrow(
      'a request to swarmy.example.com through the edges did not reach the controller — node-b: its edge answered HTTP 502, not the controller',
    );
  });

  it('a dispatch error counts as a failed probe, not a crash', async () => {
    const w = io({ a: [] }, { probe: async () => Promise.reject(new Error('node gone')) });
    await expect(verifyEdges(w.io, { deadlineMs: 0 })).rejects.toThrow(/node-a: the test request could not run there/);
  });

  it('skips, and says why, when there is no swarmy address on the edges or no edge at all', async () => {
    expect(await verifyEdges(io({ a: [OK] }, { host: async () => null }).io)).toMatchObject({ checked: [], skipped: expect.stringMatching(/no dashboard domain/) });
    expect(await verifyEdges(io({}).io)).toMatchObject({ checked: [], skipped: 'no swarmy edge runs in this cluster' });
  });
});
