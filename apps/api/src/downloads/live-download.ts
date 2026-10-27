import { CreditReceiver, STREAM_WINDOW, type StreamEndPayload } from '@swarmy/core/protocol';

/**
 * The controller's half of one download: chunks from the agent in, a
 * ReadableStream out to the HTTP response. The body is pull-based, so Bun
 * asks for the next chunk only as the browser's socket drains; each chunk
 * taken hands credit back (`CreditReceiver`), and a slow browser holds the
 * agent — and restic behind it — one window (2 MiB) ahead. Exactly one
 * `settle`. No sockets here; `download-hub.ts` wires them.
 */

export type DownloadOutcome = 'done' | 'failed' | 'canceled';

export interface LiveDownloadIO {
  credit(grant: number): void;
  /** Tell the agent to stop (the reader went away, or the agent broke the contract). */
  cancel(reason: string): void;
  settle(outcome: DownloadOutcome, bytes: number, error: { code: string; message: string } | null): void;
}

export class LiveDownload {
  readonly receiver: CreditReceiver;
  readonly body: ReadableStream<Uint8Array>;
  /** Last time the agent sent something (chunk or end), for the stall sweep. */
  lastHeardAt = Date.now();
  private queue: Uint8Array[] = [];
  private wake: (() => void) | null = null;
  private outcome: 'ok' | Error | null = null;

  constructor(
    readonly streamId: string,
    readonly nodeId: string,
    maxBytes: number,
    private readonly io: LiveDownloadIO,
    window = STREAM_WINDOW,
  ) {
    this.receiver = new CreditReceiver(window, maxBytes);
    this.body = new ReadableStream<Uint8Array>(
      { pull: (c) => this.pull(c), cancel: () => this.fail('E_CANCELED', 'the browser stopped the download', true) },
      { highWaterMark: 0 },
    );
  }

  /** Waiting on the agent with nothing to hand the reader (what a stall looks like). */
  get starved(): boolean {
    return this.wake !== null && this.queue.length === 0 && this.outcome === null;
  }

  get finished(): boolean {
    return this.outcome !== null;
  }

  chunk(seq: number, data: Uint8Array): void {
    if (this.outcome) return;
    this.lastHeardAt = Date.now();
    const v = this.receiver.arrive(seq, data.byteLength);
    if (!v.ok) return this.fail(v.code, v.message, true);
    this.queue.push(data.slice());
    this.poke();
  }

  end(p: StreamEndPayload): void {
    if (this.outcome) return;
    this.lastHeardAt = Date.now();
    if (!p.ok) return this.fail(p.error.code, p.error.message, false);
    if (!this.receiver.matches(p)) {
      return this.fail('E_PROTOCOL', `the agent said ${p.bytes} bytes in ${p.chunks} chunks; ${this.receiver.bytes} in ${this.receiver.chunks} arrived`, false);
    }
    this.outcome = 'ok';
    this.io.settle('done', this.receiver.bytes, null);
    this.poke();
  }

  /** Stop: error the body and say why. `cancelAgent` when the agent may still be sending. */
  fail(code: string, message: string, cancelAgent: boolean): void {
    if (this.outcome) return;
    this.outcome = Object.assign(new Error(message), { code });
    this.queue = [];
    if (cancelAgent) this.io.cancel(message);
    this.io.settle(code === 'E_CANCELED' ? 'canceled' : 'failed', this.receiver.bytes, { code, message });
    this.poke();
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private async pull(c: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    while (this.queue.length === 0 && this.outcome === null) {
      await new Promise<void>((r) => (this.wake = r));
    }
    const next = this.queue.shift();
    try {
      if (next) {
        c.enqueue(next);
        const grant = this.receiver.consume();
        if (grant > 0 && this.outcome === null) this.io.credit(grant);
        return;
      }
      if (this.outcome === 'ok') c.close();
      else c.error(this.outcome);
    } catch {
      // the reader already canceled: nothing left to hand it
    }
  }
}
