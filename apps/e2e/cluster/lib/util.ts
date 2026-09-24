/**
 * Small shared helpers for the cluster e2e harness: process execution,
 * polling, secret redaction, logging.
 */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── secret redaction ──────────────────────────────────────────────────────
// Every secret the harness learns (admin password, API key, join tokens, DB
// passwords, the compose secret value) is registered here and scrubbed from
// every log line, error message and report. Nothing secret is ever printed.
const secrets = new Set<string>();
export function secret(value: string | undefined | null): string {
  if (value && value.length >= 6) secrets.add(value);
  return value ?? '';
}
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('«redacted»');
  // Belt and braces: anything shaped like a swarmy token or API key.
  return out
    .replace(/\bswk_[A-Za-z0-9_-]{8,}/g, 'swk_«redacted»')
    .replace(/\bswt_[A-Za-z0-9_-]{8,}/g, 'swt_«redacted»');
}

// ── logging ───────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  dim: (s: string) => c('2', s),
  green: (s: string) => c('32', s),
  red: (s: string) => c('31', s),
  yellow: (s: string) => c('33', s),
  cyan: (s: string) => c('36', s),
  bold: (s: string) => c('1', s),
};

type LogSink = (line: string) => void;
let sink: LogSink | null = null;
/** Route `log()` lines to the current step's buffer as well as stdout. */
export function setLogSink(s: LogSink | null) {
  sink = s;
}
export function log(msg: string) {
  const line = redact(msg);
  process.stdout.write(color.dim(`    · ${line}`) + '\n');
  sink?.(line);
}
export function say(msg: string) {
  process.stdout.write(color.cyan(`▸ ${redact(msg)}`) + '\n');
}

// ── processes ─────────────────────────────────────────────────────────────
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOpts {
  input?: string | Uint8Array;
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  /** Stream stdout/stderr lines to log() while running. */
  stream?: boolean;
}

/** Run argv, capture output. Never throws on non-zero exit (check `.code`). */
export async function run(argv: string[], opts: ExecOpts = {}): Promise<ExecResult> {
  const proc = Bun.spawn(argv, {
    stdin: opts.input !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
  });
  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    await proc.stdin.end();
  }
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill(9);
      }, opts.timeoutMs)
    : null;

  const collect = async (stream: ReadableStream<Uint8Array>, into: string[]) => {
    const dec = new TextDecoder();
    let pending = '';
    for await (const chunk of stream) {
      const text = dec.decode(chunk, { stream: true });
      into.push(text);
      if (opts.stream) {
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) log(l.replace(/\x1b\[[0-9;]*m/g, ''));
      }
    }
    if (opts.stream && pending.trim()) log(pending);
  };
  const out: string[] = [];
  const err: string[] = [];
  await Promise.all([collect(proc.stdout, out), collect(proc.stderr, err)]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return {
    code: timedOut ? 124 : code,
    stdout: out.join(''),
    stderr: err.join('') + (timedOut ? `\n(killed after ${opts.timeoutMs}ms)` : ''),
  };
}

/** Run argv and throw (with a redacted tail of its output) on non-zero exit. */
export async function must(argv: string[], opts: ExecOpts = {}, what?: string): Promise<string> {
  const r = await run(argv, opts);
  if (r.code !== 0) {
    const tail = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-12).join('\n');
    throw new Error(`${what ?? argv.slice(0, 3).join(' ')} failed (exit ${r.code}): ${redact(tail)}`);
  }
  return r.stdout;
}

// ── polling ───────────────────────────────────────────────────────────────
/**
 * Retry `fn` until it returns a truthy value (returned) or `timeoutMs` passes
 * (throws with the last error / falsy result description).
 */
export async function poll<T>(
  desc: string,
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 120_000, intervalMs = 3_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = 'condition not met';
    } catch (e) {
      last = (e as Error).message;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${desc} (last: ${redact(last).slice(0, 400)})`);
    }
    await sleep(intervalMs);
  }
}

/** Shell-quote one argument for `bash -c`. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function randomId(n = 6): string {
  return Math.random().toString(36).slice(2, 2 + n);
}
