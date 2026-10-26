import { describe, expect, it } from 'bun:test';
import { planAddCopy, type AddCopyInput, type CopyServer } from './add-copy';
import { constraintHolds, nextTaskGoesTo } from './placement-match';

const node = (id: string, labels: Record<string, string> = {}, role = 'worker') => ({ swarmNodeId: `sw-${id}`, hostname: id, role, labels });
const server = (id: string, copies: number | null, tasks: number | null, labels: Record<string, string> = {}): CopyServer => ({
  id,
  name: id,
  ready: true,
  copies,
  tasks,
  node: node(id, labels),
});
const web: AddCopyInput['service'] = { short: 'web', mode: 'replicated', desired: 2, system: false, labels: {}, volumes: [] };
const plan = (patch: Partial<AddCopyInput> = {}) =>
  planAddCopy({ service: web, to: 'wkr-3', servers: [server('wkr-1', 1, 4), server('wkr-2', 1, 6), server('wkr-3', 0, 5)], ...patch });

describe('constraintHolds (swarmkit semantics)', () => {
  const n = node('wkr-1', { 'swarmy.region': 'eu' });
  it('matches ids, hostnames, roles and labels, case-insensitively', () => {
    expect(constraintHolds('node.id==sw-wkr-1', n)).toBe(true);
    expect(constraintHolds('node.hostname != WKR-1', n)).toBe(false);
    expect(constraintHolds('node.role==manager', n)).toBe(false);
    expect(constraintHolds('node.labels.swarmy.region==EU', n)).toBe(true);
  });
  it('a missing label never equals and always differs; unreadable keys are unknown', () => {
    expect(constraintHolds('node.labels.gpu==true', n)).toBe(false);
    expect(constraintHolds('node.labels.gpu!=true', n)).toBe(true);
    expect(constraintHolds('engine.labels.zone==a', n)).toBeNull();
    expect(constraintHolds('nonsense', n)).toBeNull();
  });
});

describe('nextTaskGoesTo', () => {
  const c = (id: string, copies: number, tasks: number | null, labels: Record<string, string> = {}) => ({ id, copies, tasks, node: node(id, labels) });
  it('fewest copies of the service first, then the least busy server', () => {
    expect(nextTaskGoesTo([c('a', 1, 1), c('b', 0, 9), c('c', 0, 3)]).map((x) => x.id)).toEqual(['c']);
    expect(nextTaskGoesTo([c('a', 0, 2), c('b', 0, 2)]).map((x) => x.id)).toEqual(['a', 'b']);
    expect(nextTaskGoesTo([c('a', 0, null), c('b', 0, 2)]).map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('a spread preference narrows to the least-loaded group first', () => {
    const eu = { 'swarmy.region': 'eu' };
    const us = { 'swarmy.region': 'us' };
    const pool = [c('a', 2, 1, eu), c('b', 0, 1, eu), c('c', 1, 9, us)]; // eu holds 2, us 1
    expect(nextTaskGoesTo(pool, ['spread=node.labels.swarmy.region']).map((x) => x.id)).toEqual(['c']);
  });
});

describe('planAddCopy', () => {
  it('adds one copy where Swarm would start it anyway, changing only the count', () => {
    expect(plan()).toEqual({ ok: true, replicas: 3, body: 'web runs 2 copies now. One more starts on wkr-3 and shares the load; nothing moves and nothing restarts.', note: null });
  });

  it('refuses a server Swarm would pass over, and names the one it would pick', () => {
    const p = plan({ to: 'wkr-1' });
    expect(p).toEqual({
      ok: false,
      reason: 'Swarm starts a new copy where web has the fewest copies, then on the least busy server, so it would start on wkr-3, not on wkr-1. Drop it on wkr-3 instead.',
    });
    const busier = plan({ servers: [server('wkr-1', 1, 4), server('wkr-2', 0, 2), server('wkr-3', 0, 5)] });
    expect(!busier.ok && busier.reason).toContain('it would start on wkr-2, not on wkr-3');
  });

  it('says when another server is just as free', () => {
    const p = plan({ servers: [server('wkr-1', 1, 4), server('wkr-2', 0, 5), server('wkr-3', 0, 5)] });
    expect(p.ok && p.note).toBe('wkr-2 is just as free, so Swarm may start it there instead.');
  });

  it('keeps the placement rules: a server they keep it off, or one swarmy cannot judge, is refused', () => {
    const eu = { 'swarmy.region': 'eu' };
    const servers = [server('wkr-1', 1, 4, eu), server('wkr-2', 1, 6, eu), server('wkr-3', 0, 5)];
    const ruled = plan({ servers, service: { ...web, placement: { constraints: ['node.labels.swarmy.region==eu'] } } });
    expect(!ruled.ok && ruled.reason).toBe("web's placement rules keep it off wkr-3 (node.labels.swarmy.region==eu). Change them under its Placement first.");
    const unknown = plan({ service: { ...web, placement: { constraints: ['engine.labels.zone==a'] } } });
    expect(!unknown.ok && unknown.reason).toContain("can't tell whether wkr-3 meets");
    const full = plan({ servers: [server('wkr-1', 1, 4), server('wkr-3', 1, 5)], service: { ...web, placement: { maxReplicasPerNode: 1 } } });
    expect(!full.ok && full.reason).toBe('web runs at most 1 copy per server, and wkr-3 has that already.');
  });

  it('refuses stateful, global, managed, swarmy-owned, region-declared and stopped services, saying why', () => {
    const cases: [Partial<AddCopyInput['service']>, string][] = [
      [{ volumes: ['shop_uploads'] }, 'web keeps its data on its server (shop_uploads). A copy on wkr-3 would start with an empty volume, not with that data. Drag it without ⌥ to move it instead.'],
      [{ mode: 'global' }, 'web runs one copy on every server already, so there is nothing to add on wkr-3.'],
      [{ labels: { 'swarmy.cache.cluster': 'sessions' } }, 'web is a managed data service. Add copies from its page under Data, where swarmy keeps them in step.'],
      [{ system: true }, 'web is part of swarmy itself, so swarmy decides where its copies run.'],
      [{ labels: { 'swarmy.region.eu.replicas': '2' } }, 'web runs a set number of copies in each region. Change them under its Placement.'],
      [{ desired: 0 }, 'web has no copies running. Start it first.'],
      [{ labels: { 'swarmy.move.state': '{}' } }, 'web is moving right now.'],
    ];
    for (const [patch, reason] of cases) expect(plan({ service: { ...web, ...patch } })).toEqual({ ok: false, reason });
  });

  it('refuses a server that is not ready, or not reporting', () => {
    const down = { ...server('wkr-3', 0, 5), ready: false };
    expect(plan({ servers: [server('wkr-1', 1, 4), down] })).toEqual({ ok: false, reason: "wkr-3 isn't ready for work right now." });
    expect(plan({ servers: [server('wkr-1', 1, 4), server('wkr-3', null, null)] }).ok).toBe(false);
  });
});
