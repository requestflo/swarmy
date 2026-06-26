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
}

/** Reconnecting agent→controller WebSocket client with full-jitter backoff. */
export class AgentConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private opts: ConnectionOpts) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.opts.url, SUBPROTOCOL);
    this.ws = ws;

    ws.addEventListener('open', () => {
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

    ws.addEventListener('close', () => {
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      this.ws = null;
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
