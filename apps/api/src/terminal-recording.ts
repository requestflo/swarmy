import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from './env';

/**
 * Session recording for the web terminal (epic #11, Phase 2).
 *
 * Format: asciicast v2 (https://docs.asciinema.org/manual/asciicast/v2/) — a
 * JSON header line followed by `[time, code, data]` event lines, where `code`
 * is `"o"` (output) or `"i"` (input). This is replayable by the off-the-shelf
 * `asciinema-player` in the dashboard and downloadable.
 *
 * The controller is the natural recording choke point: it sees both directions
 * and the identity. Output ("o") is ALWAYS recorded; input ("i") is recorded
 * only when `recordInput` is set (off by default — keystrokes echo secrets).
 *
 * PII / secret note: recordings are sensitive (shells echo tokens/passwords).
 * They are written under a controller-private dir, the recording is flagged in
 * the audit metadata, and read access is gated in the tRPC layer (admins/owner
 * or the actor). Phase 3 adds regex redaction + at-rest encryption.
 */

export const ASCIICAST_VERSION = 2 as const;

export interface AsciicastHeader {
  version: typeof ASCIICAST_VERSION;
  width: number;
  height: number;
  timestamp: number; // unix seconds
  title?: string;
  env?: Record<string, string>;
}

export type AsciicastEventCode = 'o' | 'i';
export type AsciicastEvent = [number, AsciicastEventCode, string];

export interface ParsedCast {
  header: AsciicastHeader;
  events: AsciicastEvent[];
}

/** Serialise a header + events to the newline-delimited asciicast v2 wire form. */
export function buildAsciicast(header: AsciicastHeader, events: AsciicastEvent[]): string {
  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  return lines.join('\n') + '\n';
}

/**
 * Parse an asciicast v2 document back into a header + ordered events. Tolerant
 * of trailing/blank lines. Used by the replay endpoint and by tests
 * (recording-chunk assembly).
 */
export function parseAsciicast(text: string): ParsedCast {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('empty cast');
  const header = JSON.parse(lines[0]!) as AsciicastHeader;
  if (header.version !== ASCIICAST_VERSION) {
    throw new Error(`unsupported asciicast version ${header.version}`);
  }
  const events: AsciicastEvent[] = [];
  for (const line of lines.slice(1)) {
    const ev = JSON.parse(line) as AsciicastEvent;
    if (Array.isArray(ev) && ev.length === 3) events.push(ev);
  }
  return { header, events };
}

/**
 * Streaming recorder for one live session. Appends events as bytes flow; the
 * `time` field is seconds since the recording opened. Buffers in memory and
 * flushes incrementally so a long session doesn't hold everything in RAM.
 */
export class TerminalRecorder {
  private readonly startedAt = Date.now();
  private opened = false;
  private buffer: string[] = [];
  private flushing: Promise<void> = Promise.resolve();
  bytes = 0;

  constructor(
    /** Recording ref, e.g. `<orgId>/<sessionId>.cast` (relative to the dir). */
    readonly ref: string,
    private readonly header: Omit<AsciicastHeader, 'version' | 'timestamp'>,
    private readonly opts: { recordInput?: boolean } = {},
  ) {}

  private absPath(): string {
    return path.join(env.TERM_RECORDING_DIR, this.ref);
  }

  /** Record one chunk of decoded (raw) terminal bytes. */
  record(code: AsciicastEventCode, data: string): void {
    if (code === 'i' && !this.opts.recordInput) return;
    const t = (Date.now() - this.startedAt) / 1000;
    const ev: AsciicastEvent = [t, code, data];
    this.bytes += data.length;
    this.buffer.push(JSON.stringify(ev));
    if (this.buffer.length >= 64) void this.flush();
  }

  /** Persist buffered lines (header on first flush). Serialised, best-effort. */
  flush(): Promise<void> {
    const pending = this.buffer;
    if (pending.length === 0 && this.opened) return this.flushing;
    this.buffer = [];
    this.flushing = this.flushing.then(async () => {
      try {
        const abs = this.absPath();
        if (!this.opened) {
          await mkdir(path.dirname(abs), { recursive: true });
          const header: AsciicastHeader = {
            version: ASCIICAST_VERSION,
            timestamp: Math.floor(this.startedAt / 1000),
            ...this.header,
          };
          await writeFile(abs, JSON.stringify(header) + '\n', 'utf8');
          this.opened = true;
        }
        if (pending.length > 0) await appendFile(abs, pending.join('\n') + '\n', 'utf8');
      } catch {
        // recording is best-effort; never break the live session
      }
    });
    return this.flushing;
  }

  /** Final flush on session close. */
  async close(): Promise<void> {
    await this.flush();
    await this.flushing;
  }
}

/** Read a stored recording back as text (for the replay endpoint). */
export async function readRecording(ref: string): Promise<string | null> {
  try {
    return await readFile(path.join(env.TERM_RECORDING_DIR, ref), 'utf8');
  } catch {
    return null;
  }
}
