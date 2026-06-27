import type { TermTarget } from '@swarmy/core/protocol';

/**
 * Single-use, short-TTL ticket store for the `/term/ws` data plane (epic #11).
 *
 * The control plane (tRPC `terminal.open` / `openNodeShell`) mints a ticket
 * AFTER the full ABAC + policy + approval gate. The browser exchanges it once on
 * WS connect. This is the CSRF defence for the upgrade and decouples the byte
 * pipe from the policy decision. Tickets are single-use and expire fast.
 */

export const TICKET_TTL_MS = 30_000;

export interface TicketClaims {
  sessionId: string;
  nodeId: string;
  orgId: string;
  userId: string;
  target: TermTarget;
}

interface StoredTicket extends TicketClaims {
  expiresAt: number;
}

export class TicketStore {
  private tickets = new Map<string, StoredTicket>();

  constructor(
    private readonly ttlMs = TICKET_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Mint a ticket for the claims. Returns the opaque ticket + expiry. */
  mint(claims: TicketClaims): { ticket: string; expiresAt: number } {
    const ticket = crypto.randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(ticket, { ...claims, expiresAt });
    return { ticket, expiresAt };
  }

  /** Claim a ticket exactly once. Returns null if unknown, used, or expired. */
  claim(ticket: string): TicketClaims | null {
    const t = this.tickets.get(ticket);
    if (!t) return null;
    this.tickets.delete(ticket); // single-use: gone whether or not it's valid
    if (t.expiresAt < this.now()) return null;
    const { expiresAt: _expiresAt, ...claims } = t;
    return claims;
  }

  /** Drop expired tickets (housekeeping). */
  sweep(): void {
    const now = this.now();
    for (const [k, v] of this.tickets) if (v.expiresAt < now) this.tickets.delete(k);
  }

  get size(): number {
    return this.tickets.size;
  }
}
