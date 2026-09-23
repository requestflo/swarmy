import { describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { pruneDanglingEverywhere } from './image-gc.service';

describe('pruneDanglingEverywhere', () => {
  it('sends a dangling-only prune to every online node (builder or not), keeping pinned digests', async () => {
    const sent: { node: string; payload: Record<string, unknown> }[] = [];
    const hub = {
      isOnline: (id: string) => id !== 'offline',
      liveInventory: () => ({ services: [], containers: [] }),
      dispatch: async (node: string, _cmd: string, payload: Record<string, unknown>) => {
        sent.push({ node, payload });
        return {};
      },
    } as unknown as AgentHub;
    const db = {
      node: { findMany: async () => [{ id: 'mgr', orgId: 'o1' }, { id: 'worker', orgId: 'o1' }, { id: 'offline', orgId: 'o1' }] },
    } as unknown as DB;
    expect(await pruneDanglingEverywhere({ db, hub })).toBe(2);
    expect(sent.map((s) => s.node)).toEqual(['mgr', 'worker']);
    for (const s of sent) expect(s.payload.strategy).toBe('dangling');
  });
});