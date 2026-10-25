import { describe, expect, it } from 'bun:test';
import { planDecommission, type DecomNodeInput, type DecommissionInput } from './node-decommission.plan';

/**
 * The retirement planner picks destinations by the mover's disk rule
 * (`diskFit`, which `planServiceMove` refuses with): where each service's data
 * fits first, never where it won't, and it says so when sizes or free disk
 * aren't reported.
 */
const GB = 1024 ** 3;

function node(id: string, disk: DecomNodeInput['disk'], labels: Record<string, string> = {}): DecomNodeInput {
  return {
    nodeId: id,
    hostname: id,
    online: true,
    disk,
    swarm: { swarmNodeId: `sw-${id}`, hostname: id, role: id === 'a' ? 'manager' : 'worker', availability: 'active', status: 'ready', leader: id === 'a', labels },
  };
}
const disk = (usedGb: number, totalGb: number) => ({ usedBytes: usedGb * GB, totalBytes: totalGb * GB });

function plan(nodes: DecomNodeInput[], volumes: DecommissionInput['volumes'], apps = ['blog_app']) {
  return planDecommission({
    targetNodeId: 'b',
    nodes,
    services: apps.map((name) => ({ name, mode: 'replicated' as const, desiredReplicas: 1, labels: {} })),
    containers: apps.map((name) => ({ name: `${name}.1`, serviceName: name, mounts: [{ type: 'volume', source: `${name}-data`, target: '/data' }] })),
    volumes,
    backupsConfigured: true,
    now: 1_800_000_000_000,
  });
}
const destOf = (p: ReturnType<typeof plan>, subject: string) => p.steps.find((s) => s.subject === subject)?.destination?.nodeId;

describe('decommission destinations: the data must fit', () => {
  it('a server where the data is known to fit beats a same-region one that reports no free disk', () => {
    const p = plan(
      [node('a', disk(10, 100)), node('b', disk(10, 100), { 'swarmy.region': 'eu' }), node('c', null, { 'swarmy.region': 'eu' })],
      [{ name: 'blog_app-data', sizeBytes: 4 * GB }],
    );
    expect(destOf(p, 'blog_app')).toBe('a');
    expect(p.warnings.filter((w) => w.includes('free disk'))).toEqual([]);
  });

  it("never a server the mover would refuse, even under the pressure line; none fits → a blocker in plain words", () => {
    // 84 GB onto an empty 100 GB disk stays under 85% but leaves less than 20% to spare.
    const p = plan([node('a', disk(0, 100)), node('b', disk(10, 200)), node('c', disk(5, 100))], [{ name: 'blog_app-data', sizeBytes: 84 * GB }]);
    expect(p.runnable).toBe(false);
    expect(p.blockers).toEqual([
      {
        code: 'no-destination',
        subject: 'blog_app',
        message: "blog_app's data is 84 GB and no other server has room for it: swarmy wants 101 GB free, and the most any has is 100 GB (a).",
        fix: 'Add a disk or a server, or free space on another server.',
      },
    ]);
  });

  it('two moves never count one disk twice: the second goes where it still fits', () => {
    const p = plan(
      [node('a', disk(0, 20)), node('b', disk(10, 100)), node('c', disk(0, 15))],
      [{ name: 'blog_app-data', sizeBytes: 10 * GB }, { name: 'blog_db-data', sizeBytes: 10 * GB }],
      ['blog_app', 'blog_db'],
    );
    expect(new Set([destOf(p, 'blog_app'), destOf(p, 'blog_db')])).toEqual(new Set(['a', 'c']));
  });

  it("says plainly when a size isn't reported, and still plans the move", () => {
    const p = plan([node('a', disk(10, 100)), node('b', disk(10, 100))], []);
    expect(destOf(p, 'blog_app')).toBe('a');
    expect(p.warnings).toContain(
      'swarmy doesn’t know how big blog_app’s data is (size not reported for blog_app-data), so it can’t check it fits on a.',
    );
  });

  it("says plainly when the destination isn't reporting its free disk", () => {
    const p = plan([node('a', null), node('b', disk(10, 100))], [{ name: 'blog_app-data', sizeBytes: GB }]);
    expect(destOf(p, 'blog_app')).toBe('a');
    expect(p.warnings).toContain('a isn’t reporting its free disk, so swarmy can’t check blog_app’s data fits.');
  });
});
