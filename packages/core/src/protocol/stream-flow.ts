import { STREAM_MAX_CREDIT } from './stream';

/**
 * Credit-based flow control for `stream.ts`, both ends. Pure state machines:
 * no I/O, no timers, so the contract is unit-tested on its own.
 *
 * The receiver (controller) starts the sender (agent) with `window` credits.
 * Each chunk spends one. The receiver hands credit back only as its reader
 * (the HTTP response) consumes chunks, and in batches of at least half a
 * window, so a slow browser holds the agent at most `window` chunks ahead.
 */

export type SendVerdict = 'send' | 'wait' | 'over-cap';

/** The agent's side: may send while it holds credit, never past `maxBytes`. */
export class CreditSender {
  private credit: number;
  private seq = 0;
  private sentBytes = 0;

  constructor(initialCredit: number, readonly maxBytes: number) {
    this.credit = clampCredit(initialCredit);
  }

  /** Credit arrived. Holding more than {@link STREAM_MAX_CREDIT} is never allowed. */
  grant(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this.credit = clampCredit(this.credit + n);
  }

  /** Whether a chunk of `len` bytes may go now. */
  check(len: number): SendVerdict {
    if (this.sentBytes + len > this.maxBytes) return 'over-cap';
    return this.credit > 0 ? 'send' : 'wait';
  }

  /** Record a sent chunk (call only after `check` said `send`); returns its seq. */
  sent(len: number): number {
    if (this.credit <= 0) throw new Error('stream sender: no credit');
    this.credit -= 1;
    this.sentBytes += len;
    return this.seq++;
  }

  get bytes(): number {
    return this.sentBytes;
  }
  get chunks(): number {
    return this.seq;
  }
  get available(): number {
    return this.credit;
  }
}

export type ArriveVerdict =
  | { ok: true }
  | { ok: false; code: 'E_PROTOCOL' | 'E_TOO_LARGE'; message: string };

/** The controller's side: checks every chunk against what it granted. */
export class CreditReceiver {
  /** Granted and not yet arrived. */
  private outstanding: number;
  /** Arrived and not yet consumed by the reader. */
  private buffered = 0;
  private nextSeq = 0;
  private gotBytes = 0;

  constructor(readonly window: number, readonly maxBytes: number) {
    this.window = clampCredit(window);
    this.outstanding = this.window;
  }

  /** The credit the start frame carries. */
  get initialCredit(): number {
    return this.window;
  }

  /** A chunk arrived. Out of order, over credit or over the cap ends the stream. */
  arrive(seq: number, len: number): ArriveVerdict {
    if (seq !== this.nextSeq) return { ok: false, code: 'E_PROTOCOL', message: `chunk ${seq} arrived, expected ${this.nextSeq}` };
    if (this.outstanding <= 0) return { ok: false, code: 'E_PROTOCOL', message: `chunk ${seq} arrived without credit` };
    if (this.gotBytes + len > this.maxBytes) return { ok: false, code: 'E_TOO_LARGE', message: `past the ${this.maxBytes}-byte cap` };
    this.outstanding -= 1;
    this.buffered += 1;
    this.nextSeq += 1;
    this.gotBytes += len;
    return { ok: true };
  }

  /** The reader took one chunk. Returns the credit to grant now (0 = not yet). */
  consume(): number {
    if (this.buffered > 0) this.buffered -= 1;
    const free = this.window - this.outstanding - this.buffered;
    if (free < Math.ceil(this.window / 2)) return 0;
    this.outstanding += free;
    return free;
  }

  /** Does an end frame's count match what arrived? */
  matches(end: { bytes: number; chunks: number }): boolean {
    return end.bytes === this.gotBytes && end.chunks === this.nextSeq;
  }

  get bytes(): number {
    return this.gotBytes;
  }
  get chunks(): number {
    return this.nextSeq;
  }
}

function clampCredit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(STREAM_MAX_CREDIT, Math.floor(n)));
}
