import { describe, expect, test } from 'bun:test';
import { meshControlProblems, type MeshControlSignal } from './resilience-mesh';

const healthy: MeshControlSignal = { managed: true, backedUp: true, replicating: true, movable: true, relaysOnEdges: true };
const ids = (s?: MeshControlSignal) => meshControlProblems(s).map((p) => `${p.id} ${p.severity}`);

describe("Resilience: the private network's control plane", () => {
  test('nothing to say when it is backed up, replicating, movable and relayed by the edges (or not in swarmy)', () => {
    expect(ids(healthy)).toEqual([]);
    expect(ids(undefined)).toEqual([]);
  });

  test('no backup is a warning that points at object storage', () => {
    const [p] = meshControlProblems({ ...healthy, backedUp: false, replicating: null });
    expect(p).toMatchObject({ id: 'mesh-control/backup', check: 'mesh-control', severity: 'warn', fixPath: '/data/buckets', resource: null });
  });

  test('a stopped replica warns; an unknown one (no report yet) does not', () => {
    expect(ids({ ...healthy, replicating: false })).toEqual(['mesh-control/backup warn']);
    expect(ids({ ...healthy, replicating: null })).toEqual([]);
  });

  test('an IP-pinned name and relays on one server are information, not alarms', () => {
    expect(ids({ ...healthy, movable: false, relaysOnEdges: false })).toEqual(['mesh-control/movable info', 'mesh-control/relays info']);
    // Without swarmy's edge in front, relays on edges isn't possible: never suggested.
    expect(ids({ ...healthy, relaysOnEdges: null })).toEqual([]);
  });

  test('plain words at Summary: no glossary terms in titles', () => {
    for (const p of meshControlProblems({ managed: true, backedUp: false, replicating: false, movable: false, relaysOnEdges: false })) {
      expect(p.title).not.toMatch(/NetBird|Litestream|mesh|STUN|sslip/i);
    }
  });
});
