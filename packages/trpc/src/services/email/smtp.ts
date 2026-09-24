/**
 * Just enough SMTP for the controller's two jobs, over `node:net`:
 *   - {@link smtpSubmit}: hand a built message to the MTA (submission :587,
 *     AUTH PLAIN, no TLS — in-cluster on the encrypted control overlay);
 *   - {@link startSmtpSink}: the bounce hook the MTA delivers its DSNs to
 *     (AUTH PLAIN required, one message per transaction, size-capped).
 * No external dependency; both are exercised against the real MTA in the
 * email e2e test.
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net';

export interface SubmitInput {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  to: string[];
  raw: string;
  helo?: string;
  timeoutMs?: number;
}

export interface SubmitResult {
  /** Final reply to DATA, e.g. `250 2.0.0 OK: queued`. */
  response: string;
  /** Per-recipient refusals (the rest were accepted). */
  rejected: Array<{ rcpt: string; reply: string }>;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly reply: string,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

/** Reads CRLF-terminated SMTP replies (multi-line `250-…` folded into one). */
class ReplyReader {
  private buf = '';
  private waiters: Array<(r: { code: number; text: string }) => void> = [];
  private lines: string[] = [];
  private failed: Error | null = null;
  private failWaiters: Array<(e: Error) => void> = [];

  push(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\r\n')) >= 0 || (idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + (this.buf[idx] === '\r' ? 2 : 1));
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const text = this.lines.join('\n');
        this.lines = [];
        const w = this.waiters.shift();
        this.failWaiters.shift();
        w?.({ code: Number(line.slice(0, 3)), text });
      }
    }
  }

  fail(e: Error): void {
    this.failed = e;
    for (const f of this.failWaiters) f(e);
    this.failWaiters = [];
    this.waiters = [];
  }

  next(): Promise<{ code: number; text: string }> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.failWaiters.push(reject);
    });
  }
}

/** Dot-stuff and terminate a message body for DATA. */
export function dataPayload(raw: string): string {
  const crlf = raw.replace(/\r?\n/g, '\r\n');
  const stuffed = crlf.replace(/^\./gm, '..');
  return `${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`;
}

const bare = (a: string): string => {
  const m = /<([^>]+)>/.exec(a);
  return (m ? m[1]! : a).trim();
};

export async function smtpSubmit(input: SubmitInput): Promise<SubmitResult> {
  const timeoutMs = input.timeoutMs ?? 20_000;
  const sock: Socket = createConnection({ host: input.host, port: input.port });
  sock.setEncoding('utf8');
  const reader = new ReplyReader();
  sock.on('data', (d: string) => reader.push(d));
  sock.on('error', (e) => reader.fail(e));
  sock.on('close', () => reader.fail(new Error('connection closed')));
  const timer = setTimeout(() => {
    reader.fail(new Error(`SMTP timeout after ${timeoutMs}ms`));
    sock.destroy();
  }, timeoutMs);
  const send = (line: string) => sock.write(`${line}\r\n`);
  const expect = async (ok: (code: number) => boolean, what: string) => {
    const r = await reader.next();
    if (!ok(r.code)) throw new SmtpError(`${what} refused: ${r.text}`, r.code, r.text);
    return r;
  };
  try {
    await expect((c) => c === 220, 'greeting');
    send(`EHLO ${input.helo ?? 'swarmy-controller'}`);
    await expect((c) => c === 250, 'EHLO');
    const token = Buffer.from(`\u0000${input.username}\u0000${input.password}`, 'utf8').toString('base64');
    send(`AUTH PLAIN ${token}`);
    await expect((c) => c === 235, 'AUTH');
    send(`MAIL FROM:<${bare(input.from)}>`);
    await expect((c) => c === 250, 'MAIL FROM');
    const rejected: SubmitResult['rejected'] = [];
    for (const rcpt of input.to) {
      send(`RCPT TO:<${bare(rcpt)}>`);
      const r = await reader.next();
      if (r.code !== 250 && r.code !== 251) rejected.push({ rcpt: bare(rcpt), reply: r.text });
    }
    if (rejected.length === input.to.length) {
      send('QUIT');
      throw new SmtpError(`all recipients refused: ${rejected[0]?.reply ?? ''}`, Number(rejected[0]?.reply.slice(0, 3)) || 550, rejected[0]?.reply ?? '');
    }
    send('DATA');
    await expect((c) => c === 354, 'DATA');
    sock.write(dataPayload(input.raw));
    const done = await expect((c) => c === 250, 'message');
    send('QUIT');
    return { response: done.text, rejected };
  } finally {
    clearTimeout(timer);
    sock.end();
  }
}

// ── sink ─────────────────────────────────────────────────────────────────────

export interface SinkMessage {
  from: string;
  to: string[];
  raw: string;
  username: string;
}

export interface SinkOptions {
  port: number;
  host?: string;
  hostname?: string;
  /** Accept a login (constant-time compare is the caller's job). */
  auth: (username: string, password: string) => boolean;
  onMessage: (m: SinkMessage) => Promise<void> | void;
  /** Refuse bigger messages (default 2 MiB — DSNs carry headers only). */
  maxBytes?: number;
}

/** A minimal authenticated SMTP receiver. Resolves once listening. */
export function startSmtpSink(opts: SinkOptions): Promise<Server> {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const server = createServer((sock) => {
    sock.setEncoding('utf8');
    sock.setTimeout(60_000, () => sock.destroy());
    let buf = '';
    let user: string | null = null;
    let from = '';
    let to: string[] = [];
    let data: string[] | null = null;
    let size = 0;
    let authPending = false;
    const reply = (s: string) => sock.write(`${s}\r\n`);
    const reset = () => {
      from = '';
      to = [];
      data = null;
      size = 0;
    };
    reply(`220 ${opts.hostname ?? 'swarmy-controller'} ESMTP swarmy bounce hook`);
    const tryAuth = (b64: string) => {
      const parts = Buffer.from(b64, 'base64').toString('utf8').split('\u0000');
      const u = parts[1] ?? '';
      const p = parts[2] ?? '';
      if (opts.auth(u, p)) {
        user = u;
        reply('235 2.7.0 authenticated');
      } else reply('535 5.7.8 invalid credentials');
    };
    const handle = async (line: string) => {
      if (data) {
        if (line === '.') {
          const raw = data.join('\r\n');
          const msg = { from, to, raw, username: user ?? '' };
          reset();
          try {
            await opts.onMessage(msg);
            reply('250 2.0.0 accepted');
          } catch {
            reply('451 4.3.0 processing failed, try again later');
          }
          return;
        }
        size += line.length + 2;
        if (size > maxBytes) {
          reset();
          reply('552 5.3.4 message too big');
          return;
        }
        data.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }
      if (authPending) {
        authPending = false;
        tryAuth(line.trim());
        return;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') {
        reply(`250-${opts.hostname ?? 'swarmy-controller'}`);
        reply(`250-SIZE ${maxBytes}`);
        reply('250 AUTH PLAIN');
      } else if (verb === 'AUTH') {
        const [, mech, arg] = line.split(/\s+/);
        if ((mech ?? '').toUpperCase() !== 'PLAIN') reply('504 5.5.4 only PLAIN');
        else if (arg) tryAuth(arg);
        else {
          authPending = true;
          reply('334 ');
        }
      } else if (verb === 'MAIL') {
        if (!user) return void reply('530 5.7.0 authentication required');
        from = /<([^>]*)>/.exec(line)?.[1] ?? '';
        reply('250 2.1.0 ok');
      } else if (verb === 'RCPT') {
        if (!user) return void reply('530 5.7.0 authentication required');
        to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
        reply('250 2.1.5 ok');
      } else if (verb === 'DATA') {
        if (!user || !to.length) return void reply('503 5.5.1 need RCPT first');
        data = [];
        reply('354 end with <CRLF>.<CRLF>');
      } else if (verb === 'RSET') {
        reset();
        reply('250 2.0.0 ok');
      } else if (verb === 'NOOP') reply('250 2.0.0 ok');
      else if (verb === 'QUIT') {
        reply('221 2.0.0 bye');
        sock.end();
      } else reply('502 5.5.2 not implemented');
    };
    let chain = Promise.resolve();
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        chain = chain.then(() => handle(line));
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve, reject) => {
    (server as unknown as { on(ev: 'error', fn: (e: Error) => void): void }).on('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve(server));
  });
}
