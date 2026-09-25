import {
  AGENT_LINK_IDLE_TIMEOUT_MS,
  AGENT_STRANDED_EXIT_MS,
  BACKOFF,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  ControllerEnvelope,
  parseControllerEnvelope,
  type RegisterAckPayload,
  type RegisterPayload,
} from '@swarmy/core/protocol';

interface ConnectionOpts {
  url: string;
  /** Re-resolved before every dial when set (host-network agent, QA-066 e); falls back to `url`. */
  resolveUrl?: () => Promise<string>;
  buildRegister: () => RegisterPayload;
  onRegisterAck: (payload: RegisterAckPayload) => void;
  onCommand: (env: ControllerEnvelope) => void;
  /** Controller rejected our register auth (4401/4403) — fix credentials before the redial. */
  onAuthRejected?: (code: number, reason: string) => void;
  /**
   * No live link for `strandedMs` (every redial failing or dying): this node's
   * own network path is presumed broken. The daemon exits a container agent so
   * its restart policy recycles it with a fresh overlay endpoint.
   */
  onStranded?: (downForMs: number) => void;
  /** Tunables (tests). */
  idleMs?: number;
  strandedMs?: number;
  backoff?: { baseMs: number; maxMs: number; factor: number; stableMs: number; dialTimeoutMs: number };
  watchdogMs?: number;
}

/**
 * PURE — is the open link dead? Only once the controller has proven it echoes
 * (an older controller sends nothing unprompted, and must not be dropped), and
 * then only after `idleMs` with no inbound frame at all.
 */
export function linkIsDead(s: { armed: boolean; lastInboundAt: number; now: number; idleMs: number }): boolean {
  return s.armed && s.now - s.lastInboundAt > s.idleMs;
}

/**
 * PURE — should a stranded agent exit? A container agent: yes (its restart
 * policy recycles it with a fresh overlay endpoint). A host binary: no, its
 * path is the host network, so redialing is all it can do.
 * `SWARMY_EXIT_WHEN_STRANDED=0|1` overrides.
 */
export function strandedShouldExit(
  packaging: 'binary' | 'container',
  override: string | undefined = process.env.SWARMY_EXIT_WHEN_STRANDED,
): boolean {
  if (override === '0' || override === 'false') return false;
  if (override === '1' || override === 'true') return true;
  return packaging === 'container';
}

/** Consecutive unreadable commands on one link before the agent redials (QA-063). */
export const MAX_DROPPED_COMMANDS = 3;

export interface DroppedFrame {
  /** Wire `type`, or `(unknown)` when the frame isn't even JSON with a type. */
  type: string;
  /** The command's `payload.commandId`, when one can be read — the controller is waiting on it. */
  commandId?: string;
  /** Why it was dropped, in one line (zod issue paths + messages, or the JSON error). */
  reason: string;
}

/**
 * PURE — why a controller frame can't be handled, or null when it parses.
 * A dropped command used to vanish without a trace: the controller timed out
 * (swarmJoin 6/6) while the agent logged nothing (QA-063).
 */
export function describeDroppedFrame(data: unknown): DroppedFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(String(data));
  } catch (e) {
    return { type: '(unknown)', reason: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = ControllerEnvelope.safeParse(raw);
  if (r.success) return null;
  const obj = (raw ?? {}) as { type?: unknown; payload?: { commandId?: unknown } };
  const type = typeof obj.type === 'string' ? obj.type : '(unknown)';
  const commandId = typeof obj.payload?.commandId === 'string' ? obj.payload.commandId : undefined;
  const reason = r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
    .join('; ');
  return { type, ...(commandId ? { commandId } : {}), reason };
}

/** Reconnecting agent→controller WebSocket client with full-jitter backoff. */
export class AgentConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private dials = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Last inbound frame on the current socket (ms). */
  private lastInboundAt = 0;
  /** The controller echoes heartbeats (seen at least one `ping`) → the idle check applies. */
  private livenessArmed = false;
  /** Last time the link was proven alive (an inbound frame), or start. */
  private lastAliveAt = Date.now();
  private strandedReported = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Drops the current socket and redials (set per dial). */
  private abandonCurrent: ((reason: string) => void) | null = null;
  private readonly backoff: NonNullable<ConnectionOpts['backoff']>;
  private readonly idleMs: number;
  private readonly strandedMs: number;
  /** Unreadable commands in a row on the current link (reset by any handled one). */
  private droppedInARow = 0;
  /** `type: reason` keys already logged — each distinct drop is logged once. */
  private readonly droppedLogged = new Set<string>();

  constructor(private opts: ConnectionOpts) {
    this.backoff = opts.backoff ?? BACKOFF;
    this.idleMs = opts.idleMs ?? AGENT_LINK_IDLE_TIMEOUT_MS;
    this.strandedMs = opts.strandedMs ?? AGENT_STRANDED_EXIT_MS;
  }

  start(): void {
    this.lastAliveAt = Date.now();
    this.watchdog = setInterval(() => this.checkLink(), this.opts.watchdogMs ?? 5_000);
    this.connect();
  }

  /**
   * Dead-link watchdog. An OPEN socket whose peer vanished without a FIN/RST
   * (controller task killed, the overlay veth NO-CARRIER) never fires close,
   * and writes still "succeed" into the kernel buffer — the agent used to sit
   * "connected" until restarted. Silence past `idleMs` drops it and redials
   * (a fresh dial re-resolves the controller name). A link that stays down
   * past `strandedMs` reports `onStranded` once per outage.
   */
  private checkLink(): void {
    if (this.closed) return;
    const now = Date.now();
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      linkIsDead({ armed: this.livenessArmed, lastInboundAt: this.lastInboundAt, now, idleMs: this.idleMs })
    ) {
      this.abandonCurrent?.(`no frame from the controller for ${Math.round((now - this.lastInboundAt) / 1000)}s`);
    }
    if (!this.strandedReported && now - this.lastAliveAt > this.strandedMs) {
      this.strandedReported = true;
      this.opts.onStranded?.(now - this.lastAliveAt);
    }
  }

  private connect(): void {
    if (!this.opts.resolveUrl) return this.dial(this.opts.url);
    void this.opts
      .resolveUrl()
      .catch(() => this.opts.url)
      .then((url) => {
        if (!this.closed) this.dial(url);
      });
  }

  private dial(url: string): void {
    this.dials += 1;
    if (this.dials > 1) console.log(`[swarmy-agent] redialing controller (attempt ${this.dials})`);
    const ws = new WebSocket(url, SUBPROTOCOL);
    this.ws = ws;
    this.lastInboundAt = Date.now();
    this.livenessArmed = false;

    // A dial can hang forever (SYN dropped, upgrade never answered — e.g. a
    // controller mid-restart accepts the TCP connection but never upgrades)
    // without firing open/close/error, which would strand the agent silently
    // until a manual restart. Enforce a deadline ourselves: close() on a
    // still-CONNECTING socket does not reliably fire the close event, so the
    // timer schedules the reconnect directly; `settled` keeps the close
    // handler from double-scheduling if the event does arrive.
    let settled = false;
    const abandon = (reason: string) => {
      if (settled) return;
      settled = true;
      console.log(`[swarmy-agent] dropping controller link: ${reason}`);
      clearTimeout(dialTimer);
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      try {
        ws.close();
      } catch {
        /* already dead */
      }
      if (this.ws === ws) this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    };
    this.abandonCurrent = abandon;
    const dialTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN || settled) return;
      abandon('dial timed out');
    }, this.backoff.dialTimeoutMs);

    ws.addEventListener('open', () => {
      clearTimeout(dialTimer);
      this.droppedInARow = 0;
      this.send('register', this.opts.buildRegister());
      this.stableTimer = setTimeout(() => {
        this.attempt = 0;
      }, this.backoff.stableMs);
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      // Any inbound frame proves the link alive.
      this.lastInboundAt = Date.now();
      this.lastAliveAt = this.lastInboundAt;
      this.strandedReported = false;
      let env: ControllerEnvelope;
      try {
        env = parseControllerEnvelope(JSON.parse(String(ev.data)));
      } catch {
        this.onDroppedFrame(ev.data);
        return;
      }
      if (env.type === 'ping') {
        this.livenessArmed = true;
        // Heartbeat echoes are liveness only — not commands to ack.
        if (env.payload.nonce.startsWith('hb-')) return;
      }
      if (env.type === 'registerAck') {
        this.opts.onRegisterAck(env.payload);
        return;
      }
      this.droppedInARow = 0; // a command we can read: the link is not wedged
      this.opts.onCommand(env);
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      if (ev.code !== 1000 && ev.code !== 1001) {
        console.log(`[swarmy-agent] controller socket closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`);
      }
      if (ev.code === 4401 || ev.code === 4403) this.opts.onAuthRejected?.(ev.code, ev.reason);
      clearTimeout(dialTimer);
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      if (settled) return; // dial-timeout path already scheduled the reconnect
      settled = true;
      if (this.ws === ws) this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // The close handler schedules the reconnect.
    });
  }

  /**
   * A frame the agent can't parse. Log it (once per distinct type+reason), answer
   * a command with a `failed` result so the controller sees WHY instead of a
   * timeout, and after MAX_DROPPED_COMMANDS in a row redial: a fresh register
   * re-sends current facts, which is what unstuck lon1-b (QA-063).
   */
  private onDroppedFrame(data: unknown): void {
    const d = describeDroppedFrame(data);
    if (!d) return;
    const key = `${d.type}: ${d.reason}`;
    if (!this.droppedLogged.has(key)) {
      this.droppedLogged.add(key);
      console.log(`[swarmy-agent] dropped an unreadable controller frame (${d.type}): ${d.reason}`);
    }
    if (!d.commandId) return;
    this.send('commandResult', {
      commandId: d.commandId,
      status: 'failed',
      finishedAt: Date.now(),
      error: { code: 'E_MALFORMED', message: `the agent could not read this ${d.type} command: ${d.reason}` },
    });
    this.droppedInARow += 1;
    if (this.droppedInARow >= MAX_DROPPED_COMMANDS) {
      this.droppedInARow = 0;
      this.abandonCurrent?.(`${MAX_DROPPED_COMMANDS} controller commands in a row were unreadable — re-registering`);
    }
  }

  private scheduleReconnect(): void {
    const b = this.backoff;
    const ceiling = Math.min(b.maxMs, b.baseMs * b.factor ** this.attempt);
    const delay = Math.random() * ceiling;
    this.attempt += 1;
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
  }

  send(type: string, payload: unknown): void {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(
      JSON.stringify({ v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: Date.now(), type, payload }),
    );
  }

  get connected(): boolean {
    return this.ws?.readyState === 1;
  }

  /**
   * Force a fresh dial NOW (CLI `swarmy-agent reconnect`). Closing an open
   * socket lets the close handler schedule the redial through the normal
   * path; resetting `attempt` first collapses any accumulated backoff so the
   * redial is immediate instead of minutes away.
   */
  redial(): void {
    this.attempt = 0;
    if (this.ws && this.ws.readyState <= 1) {
      try {
        this.ws.close();
      } catch {
        // close handler still fires / reconnect already scheduled
      }
    } else {
      this.connect();
    }
  }

  stop(): void {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.ws?.close();
  }
}
