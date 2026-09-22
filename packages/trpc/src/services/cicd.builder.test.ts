import { describe, expect, it } from 'bun:test';
import { NODE_BUILDER_LABEL } from '@swarmy/core';
import { pickBuilderNode, type BuilderCandidate } from './cicd.service';
import { stampDefaultBuilderRole } from './node.service';
import type { AgentHub } from '../hub/types';

const node = (over: Partial<BuilderCandidate> & { id: string }): BuilderCandidate => ({
  labels: {},
  buildOverride: undefined,
  online: true,
  ...over,
});

describe('pickBuilderNode', () => {
  it('picks an online Builder-role node (new or legacy label)', () => {
    expect(
      pickBuilderNode([node({ id: 'a' }), node({ id: 'b', labels: { [NODE_BUILDER_LABEL]: 'true' } })]),
    ).toEqual({ ok: true, id: 'b' });
    expect(pickBuilderNode([node({ id: 'c', labels: { 'swarmy.role': 'builder' } })])).toEqual({ ok: true, id: 'c' });
  });

  it('honours the agent override: SWARMY_ALLOW_BUILD=true counts, =false vetoes', () => {
    expect(pickBuilderNode([node({ id: 'a', buildOverride: 'allow' })])).toEqual({ ok: true, id: 'a' });
    const vetoed = pickBuilderNode([node({ id: 'a', labels: { [NODE_BUILDER_LABEL]: 'true' }, buildOverride: 'deny' })]);
    expect(vetoed.ok).toBe(false);
  });

  it('never falls back to a non-builder node; the error says how to enable one', () => {
    const r = pickBuilderNode([node({ id: 'a' }), node({ id: 'b' })]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("'Builder' role");
      expect(r.reason).toContain('SWARMY_ALLOW_BUILD=true');
    }
  });

  it('says the builder is offline (by name) rather than "none exist"', () => {
    const r = pickBuilderNode([node({ id: 'a', name: 'box-1', online: false, labels: { [NODE_BUILDER_LABEL]: 'true' } })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('box-1');
  });
});

describe('stampDefaultBuilderRole', () => {
  function hubWith(labels: Record<string, string> | undefined): { hub: AgentHub; dispatched: unknown[] } {
    const dispatched: unknown[] = [];
    const hub = {
      nodeInfoFor: () => (labels ? { labels } : undefined),
      swarmNodeIdFor: () => 'swarm-1',
      managerNodes: () => ['mgr'],
      isOnline: () => true,
      dispatch: async (_n: string, _c: string, p: unknown) => {
        dispatched.push(p);
        return {};
      },
    } as unknown as AgentHub;
    return { hub, dispatched };
  }

  it('does nothing when the org has more than one node', async () => {
    const { hub, dispatched } = hubWith({});
    const db = { node: { count: async () => 2 } };
    expect(await stampDefaultBuilderRole({ db, hub }, 'org', 'n1', { attempts: 1, delayMs: 0 })).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it('is a no-op success when the only node already carries the role', async () => {
    const { hub } = hubWith({ [NODE_BUILDER_LABEL]: 'true' });
    const db = { node: { count: async () => 1 } };
    expect(await stampDefaultBuilderRole({ db, hub }, 'org', 'n1', { attempts: 1, delayMs: 0 })).toBe(true);
  });
});
