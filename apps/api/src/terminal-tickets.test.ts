import { describe, expect, it } from 'bun:test';
import { TicketStore, TICKET_TTL_MS } from './terminal-tickets';
import type { TermTarget } from '@swarmy/core/protocol';

const target: TermTarget = { kind: 'container', containerId: 'c1', cmd: [] };
const claims = { sessionId: 's1', nodeId: 'n1', orgId: 'o1', userId: 'u1', target };

describe('TicketStore', () => {
  it('mints a ticket that can be claimed exactly once', () => {
    const store = new TicketStore();
    const { ticket } = store.mint(claims);
    expect(store.size).toBe(1);

    const first = store.claim(ticket);
    expect(first).not.toBeNull();
    expect(first?.sessionId).toBe('s1');
    expect(first?.target.kind).toBe('container');
    expect(store.size).toBe(0);

    // Single-use: a second claim fails.
    expect(store.claim(ticket)).toBeNull();
  });

  it('rejects an unknown ticket', () => {
    const store = new TicketStore();
    expect(store.claim('nope')).toBeNull();
  });

  it('rejects (and consumes) an expired ticket', () => {
    let now = 1_000;
    const store = new TicketStore(TICKET_TTL_MS, () => now);
    const { ticket, expiresAt } = store.mint(claims);
    expect(expiresAt).toBe(1_000 + TICKET_TTL_MS);

    now = 1_000 + TICKET_TTL_MS + 1; // past expiry
    expect(store.claim(ticket)).toBeNull();
    expect(store.size).toBe(0); // expired claim still removed
  });

  it('claims a ticket that is still within TTL', () => {
    let now = 0;
    const store = new TicketStore(TICKET_TTL_MS, () => now);
    const { ticket } = store.mint(claims);
    now = TICKET_TTL_MS - 1;
    expect(store.claim(ticket)).not.toBeNull();
  });

  it('sweep drops only expired tickets', () => {
    let now = 0;
    const store = new TicketStore(100, () => now);
    store.mint(claims);
    now = 50;
    store.mint({ ...claims, sessionId: 's2' });
    now = 120; // first expired (at 100), second valid until 150
    store.sweep();
    expect(store.size).toBe(1);
  });
});
