import type { CreditSender, StreamErrorCode } from '@swarmy/core/protocol';

/**
 * The agent's half of a snapshot download, without the Docker: bytes from
 * restic in, credit-limited chunks out (`stream-flow.ts`). When a full chunk
 * waits for credit the producer is paused, so the container blocks on its
 * stdout instead of the agent buffering a whole volume. Exactly one `end`.
 * No timers or sockets here; the glue (`snapshot-dump.ts`) wires them.
 */

export type PumpEnd =
  | { ok: true; bytes: number; chunks: number }
  | { ok: false; bytes: number; error: { code: StreamErrorCode; message: string } };

export interface PumpIO {
  sendChunk(seq: number, data: Uint8Array): void;
  /** Stop reading the producer (backpressure). */
  pause(): void;
  resume(): void;
  /** The stream is over. A failed end also means: kill the producer. */
  end(result: PumpEnd): void;
}

/** The last lines of restic's stderr, where it says why. */
export function stderrWhy(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-4).join('\n').slice(-600) || 'restic stopped without saying why';
}

export class DumpPump {
  private queue: Uint8Array[] = [];
  private partial: Uint8Array[] = [];
  private partialLen = 0;
  private received = 0;
  private paused = false;
  private exit: number | null = null;
  private over = false;
  private lastProgressAt: number;

  constructor(
    private readonly io: PumpIO,
    private readonly sender: CreditSender,
    private readonly chunkBytes: number,
    /** Words for a cap breach: which limit, and where it is set. */
    private readonly capWords: string,
    private readonly now: () => number = Date.now,
  ) {
    this.lastProgressAt = now();
  }

  /** Bytes from the producer's stdout. */
  data(buf: Uint8Array): void {
    if (this.over) return;
    this.received += buf.byteLength;
    if (this.received > this.sender.maxBytes) return this.fail('E_TOO_LARGE', this.capWords);
    let off = 0;
    while (off < buf.byteLength) {
      const take = Math.min(this.chunkBytes - this.partialLen, buf.byteLength - off);
      this.partial.push(buf.subarray(off, off + take));
      this.partialLen += take;
      off += take;
      if (this.partialLen === this.chunkBytes) this.cut();
    }
    this.pump();
  }

  /** The controller granted `n` more chunks. */
  credit(n: number): void {
    if (this.over) return;
    this.lastProgressAt = this.now();
    this.sender.grant(n);
    this.pump();
  }

  /** The producer exited and all its output was read. */
  exited(code: number, stderr: string): void {
    if (this.over) return;
    if (code !== 0) {
      const why = stderrWhy(stderr);
      return this.fail(/not found in snapshot|no matching ID found|no snapshot/i.test(why) ? 'E_NOT_FOUND' : 'E_SOURCE', why);
    }
    this.exit = code;
    this.cut();
    this.pump();
  }

  /** Stop now (controller cancel, stall, agent error). No-op once over. */
  fail(code: StreamErrorCode, message: string): void {
    if (this.over) return;
    this.over = true;
    this.queue = [];
    this.partial = [];
    this.io.end({ ok: false, bytes: this.sender.bytes, error: { code, message } });
  }

  /** How long the pump has waited for credit with output queued (0 when not waiting). */
  stalledFor(now = this.now()): number {
    return this.paused && !this.over ? now - this.lastProgressAt : 0;
  }

  get done(): boolean {
    return this.over;
  }

  private cut(): void {
    if (this.partialLen === 0) return;
    const chunk = new Uint8Array(this.partialLen);
    let at = 0;
    for (const p of this.partial) {
      chunk.set(p, at);
      at += p.byteLength;
    }
    this.queue.push(chunk);
    this.partial = [];
    this.partialLen = 0;
  }

  private pump(): void {
    while (this.queue.length > 0 && !this.over) {
      const chunk = this.queue[0]!;
      const verdict = this.sender.check(chunk.byteLength);
      if (verdict === 'over-cap') return this.fail('E_TOO_LARGE', this.capWords);
      if (verdict === 'wait') break;
      this.queue.shift();
      this.io.sendChunk(this.sender.sent(chunk.byteLength), chunk);
      this.lastProgressAt = this.now();
    }
    if (this.over) return;
    const blocked = this.queue.length > 0;
    if (blocked && !this.paused) {
      this.paused = true;
      this.lastProgressAt = this.now();
      this.io.pause();
    } else if (!blocked && this.paused) {
      this.paused = false;
      this.io.resume();
    }
    if (!blocked && this.exit === 0) {
      this.over = true;
      this.io.end({ ok: true, bytes: this.sender.bytes, chunks: this.sender.chunks });
    }
  }
}
