import type { ServerWebSocket } from 'bun';
import { auth } from '@swarmy/auth';
import { prisma } from '@swarmy/db';
import { writeAudit } from '@swarmy/trpc';
import {
  PROTOCOL_VERSION,
  TermCloseCode,
  type TermTarget,
  type TermStartedPayload,
  type TermDataPayload,
  type TermExitPayload,
} from '@swarmy/core/protocol';
import { registry } from './gateway';

/**
 * Browser-facing terminal data plane (`/term/ws`).
 *
 * Split of concerns (see epic): tRPC is the control plane (RBAC/policy/audit,
 * mints a single-use ticket); this WS is the byte pipe. It authenticates the
 * Better Auth session cookie at upgrade + a single-use ticket, then relays
 * `term*` frames between the browser and the target node's agent connection
 * (via the existing `ConnectionRegistry`).
 *
 * Wiring (see INTEGRATION):
 *  - apps/api/src/index.ts: add the `/term/ws` upgrade branch and a `websocket`
 *    handler set (Bun allows one websocket config per serve → branch on a
 *    `kind` discriminant in ws.data, or run on a second Bun.serve port).
 *  - apps/api/src/gateway/protocol-handlers.ts: route inbound agent frames
 *    `termStarted` / `termData` / `termExit` to `onAgentTermFrame(...)`.
 */

const TICKET_TTL_MS = 30_000;

export interface TermWsData {
  kind: 'term';
  ticket: string;
}

export type TermSocket = ServerWebSocket<TermWsData>;

interface Ticket {
  sessionId: string;
  nodeId: string;
  orgId: string;
  userId: string;
  target: TermTarget;
  expiresAt: number;
}

interface LiveSession {
  sessionId: string;
  nodeId: string;
  orgId: string;
  userId: string;
  target: TermTarget;
  ws: TermSocket;
  bytesIn: number;
  bytesOut: number;
}

function frame(type: string, payload: unknown): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: Date.now(), type, payload });
}

class TerminalHub {
  private tickets = new Map<string, Ticket>();
  private sessions = new Map<string, LiveSession>();
  private byTicket = new Map<string, string>(); // ticket → sessionId

  /**
   * Control plane (tRPC) calls this after the full policy gate to mint a
   * single-use, short-lived ticket. Returns the ticket string the browser
   * passes to `/term/ws?ticket=…`.
   */
  mintTicket(input: {
    sessionId: string;
    nodeId: string;
    orgId: string;
    userId: string;
    target: TermTarget;
  }): { ticket: string; expiresAt: number } {
    const ticket = crypto.randomUUID();
    const expiresAt = Date.now() + TICKET_TTL_MS;
    this.tickets.set(ticket, { ...input, ticket, expiresAt } as Ticket);
    setTimeout(() => this.tickets.delete(ticket), TICKET_TTL_MS).unref?.();
    return { ticket, expiresAt };
  }

  /** Validate (single-use) a ticket on WS connect. */
  private claimTicket(ticket: string): Ticket | null {
    const t = this.tickets.get(ticket);
    if (!t) return null;
    this.tickets.delete(ticket);
    if (t.expiresAt < Date.now()) return null;
    return t;
  }

  /** Browser socket connected with a ticket. Starts the agent-side session. */
  async onBrowserOpen(ws: TermSocket): Promise<void> {
    const t = this.claimTicket(ws.data.ticket);
    if (!t) {
      ws.close(TermCloseCode.UNAUTHORIZED, 'invalid or expired ticket');
      return;
    }
    if (!registry.isOnline(t.nodeId)) {
      ws.close(TermCloseCode.SESSION_GONE, 'node offline');
      return;
    }

    const session: LiveSession = {
      sessionId: t.sessionId,
      nodeId: t.nodeId,
      orgId: t.orgId,
      userId: t.userId,
      target: t.target,
      ws,
      bytesIn: 0,
      bytesOut: 0,
    };
    this.sessions.set(t.sessionId, session);
    this.byTicket.set(ws.data.ticket, t.sessionId);

    registry.send(
      t.nodeId,
      JSON.parse(
        frame('termStart', {
          sessionId: t.sessionId,
          target: t.target,
          cols: 80,
          rows: 24,
        }),
      ),
    );

    await writeAudit(
      { db: prisma, activeOrgId: t.orgId, user: { id: t.userId } },
      {
        action: 'terminal.open',
        targetType: t.target.kind === 'container' ? 'container' : 'node',
        targetId: t.target.kind === 'container' ? t.target.containerId : t.nodeId,
        actorType: 'user',
        actorId: t.userId,
        metadata: { sessionId: t.sessionId, nodeId: t.nodeId, target: t.target },
      },
    );
  }

  /** Browser → agent frames (termInput / termResize). */
  onBrowserMessage(ws: TermSocket, raw: string): void {
    const sessionId = this.byTicket.get(ws.data.ticket);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    let msg: { type?: string; payload?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'termInput' && typeof msg.payload?.data === 'string') {
      session.bytesIn += msg.payload.data.length;
      registry.send(session.nodeId, JSON.parse(frame('termInput', { ...msg.payload, sessionId })));
    } else if (msg.type === 'termResize') {
      registry.send(session.nodeId, JSON.parse(frame('termResize', { ...msg.payload, sessionId })));
    }
  }

  /** Browser closed → tear down the agent-side session. */
  async onBrowserClose(ws: TermSocket): Promise<void> {
    const sessionId = this.byTicket.get(ws.data.ticket);
    this.byTicket.delete(ws.data.ticket);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    registry.send(session.nodeId, JSON.parse(frame('termClose', { sessionId })));
    await this.recordClose(session, null, 'closed');
  }

  /**
   * Inbound agent → controller term frames, routed here from
   * gateway/protocol-handlers.ts. The agent protocol handler receives these on
   * the agent socket and forwards by `payload.sessionId`.
   */
  onAgentTermFrame(
    type: 'termStarted' | 'termData' | 'termExit',
    payload: TermStartedPayload | TermDataPayload | TermExitPayload,
  ): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session) return;
    if (session.ws.readyState !== 1) return;

    if (type === 'termData') {
      const p = payload as TermDataPayload;
      session.bytesOut += p.data.length;
      session.ws.send(frame('termData', p));
      return;
    }
    if (type === 'termStarted') {
      const p = payload as TermStartedPayload;
      session.ws.send(frame('termStarted', p));
      if (!p.ok) {
        // Failed to start (e.g. exec disabled): close the browser socket.
        this.sessions.delete(session.sessionId);
        session.ws.close(TermCloseCode.FORBIDDEN, p.error.code);
      }
      return;
    }
    // termExit
    const p = payload as TermExitPayload;
    session.ws.send(frame('termExit', p));
    this.sessions.delete(session.sessionId);
    void this.recordClose(session, p.exitCode, p.reason);
    session.ws.close(1000, 'session ended');
  }

  private async recordClose(
    session: LiveSession,
    exitCode: number | null,
    reason: string,
  ): Promise<void> {
    await writeAudit(
      { db: prisma, activeOrgId: session.orgId, user: { id: session.userId } },
      {
        action: 'terminal.close',
        targetType: session.target.kind === 'container' ? 'container' : 'node',
        targetId:
          session.target.kind === 'container' ? session.target.containerId : session.nodeId,
        actorType: 'user',
        actorId: session.userId,
        metadata: {
          sessionId: session.sessionId,
          nodeId: session.nodeId,
          exitCode,
          reason,
          bytesIn: session.bytesIn,
          bytesOut: session.bytesOut,
        },
      },
    );
  }
}

export const terminalHub = new TerminalHub();

/**
 * Authenticate a `/term/ws` upgrade: requires a valid Better Auth session
 * cookie. (The ticket is validated on `open`, single-use.) Returns the ws.data
 * to attach, or null to reject the upgrade. Called from index.ts (see snippet).
 */
export async function authorizeTermUpgrade(req: Request): Promise<TermWsData | null> {
  const url = new URL(req.url);
  const ticket = url.searchParams.get('ticket');
  if (!ticket) return null;
  const sess = await auth.api.getSession({ headers: req.headers });
  if (!sess?.session || !sess.user) return null;
  return { kind: 'term', ticket };
}

/** Bun websocket handlers for the terminal data plane. */
export const terminalWebSocketHandlers = {
  open(ws: TermSocket) {
    void terminalHub.onBrowserOpen(ws);
  },
  message(ws: TermSocket, message: string | Buffer) {
    terminalHub.onBrowserMessage(ws, typeof message === 'string' ? message : message.toString());
  },
  close(ws: TermSocket) {
    void terminalHub.onBrowserClose(ws);
  },
};
