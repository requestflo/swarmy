import {
  BACKOFF,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  parseControllerEnvelope,
  type ControllerEnvelope,
  type RegisterAckPayload,
  type RegisterPayload,
} from '@swarmy/core/protocol';

interface ConnectionOpts {
  url: string;
  buildRegister: () => RegisterPayload;
  onRegisterAck: (payload: RegisterAckPayload) => void;
  onCommand: (env: ControllerEnvelope) => void;
  /** Controller rejected our register auth (4401/4403) — fix credentials before the redial. */
  onAuthRejected?: (code: number, reason: string) => void;
}

/** Reconnecting agent→controller WebSocket client with full-jitter backoff. */
export class AgentConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private dials = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private opts: ConnectionOpts) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    this.dials += 1;
    if (this.dials > 1) console.log(`[swarmy-agent] redialing controller (attempt ${this.dials})`);
    const ws = new WebSocket(this.opts.url, SUBPROTOCOL);
    this.ws = ws;

    // A dial can hang forever (SYN dropped, upgrade never answered — e.g. a
    // controller mid-restart accepts the TCP connection but never upgrades)
    // without firing open/close/error, which would strand the agent silently
    // until a manual restart. Enforce a deadline ourselves: close() on a
    // still-CONNECTING socket does not reliably fire the close event, so the
    // timer schedules the reconnect directly; `settled` keeps the close
    // handler from double-scheduling if the event does arrive.
    let settled = false;
    const dialTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN || settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already dead */
      }
      if (this.ws === ws) this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    }, BACKOFF.dialTimeoutMs);

    ws.addEventListener('open', () => {
      clearTimeout(dialTimer);
      this.send('register', this.opts.buildRegister());
      this.stableTimer = setTimeout(() => {
        this.attempt = 0;
      }, BACKOFF.stableMs);
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      let env: ControllerEnvelope;
      try {
        env = parseControllerEnvelope(JSON.parse(String(ev.data)));
      } catch {
        return;
      }
      if (env.type === 'registerAck') {
        this.opts.onRegisterAck(env.payload);
        return;
      }
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

  private scheduleReconnect(): void {
    const ceiling = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * BACKOFF.factor ** this.attempt);
    const delay = Math.random() * ceiling;
    this.attempt += 1;
    setTimeout(() => this.connect(), delay);
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

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }
}
