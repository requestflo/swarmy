/**
 * Shared plumbing for the swarmy-agent CLI: daemon socket client, controller
 * URL derivation, terminal formatting, and confirmation prompts.
 *
 * Design rule: every CLI command must work in BOTH worlds — daemon running
 * (talk to it over the unix socket for live state) and daemon dead (fall back
 * to direct inspection), because the daemon being dead is exactly when the
 * operator reaches for this tool.
 */
import { env } from '../env';
import type { DaemonStatus } from '../local-socket';

// ── daemon socket client ────────────────────────────────────────────────────

/** GET the daemon's live status over the unix socket; null when it's down. */
export async function daemonStatus(): Promise<DaemonStatus | null> {
  return daemonRequest<DaemonStatus>('GET', '/status');
}

export async function daemonReconnect(): Promise<boolean> {
  const res = await daemonRequest<{ ok: boolean }>('POST', '/reconnect');
  return res?.ok ?? false;
}

async function daemonRequest<T>(method: string, pathname: string): Promise<T | null> {
  try {
    // Bun's fetch dials unix sockets via the `unix` option; the hostname is
    // ignored but required for URL parsing.
    const res = await fetch(`http://swarmy-agent.local${pathname}`, {
      method,
      unix: env.SOCKET_PATH,
      signal: AbortSignal.timeout(1_500),
    } as RequestInit & { unix: string });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── controller reachability ─────────────────────────────────────────────────

/** Derive the controller's HTTP base from the agent's WS URL (ws://h:p/agent/ws → http://h:p). */
export function controllerHttpBase(): string {
  const url = new URL(env.AGENT_WS_URL);
  const proto = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${proto}//${url.host}`;
}

export interface ControllerProbe {
  reachable: boolean;
  latencyMs?: number;
  agentVersion?: string;
  error?: string;
}

/** Probe the controller's install manifest — cheap, unauthenticated, version-bearing. */
export async function probeController(): Promise<ControllerProbe> {
  const started = Date.now();
  try {
    const res = await fetch(`${controllerHttpBase()}/install/bin/manifest.json`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const manifest = (await res.json()) as { version?: string };
    return { reachable: true, latencyMs: Date.now() - started, agentVersion: manifest.version };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── terminal formatting ─────────────────────────────────────────────────────

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const fmt = {
  green: paint(32),
  yellow: paint(33),
  red: paint(31),
  cyan: paint(36),
  bold: paint(1),
  dim: paint(2),
};

export const GLYPH = {
  ok: fmt.green('●'),
  warn: fmt.yellow('●'),
  fail: fmt.red('●'),
  skip: fmt.dim('○'),
} as const;

export function say(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

export function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(fmt.red(`✗ ${msg}`));
  process.exit(1);
}

export function humanDuration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 90) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 36) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ── confirmations ───────────────────────────────────────────────────────────

/**
 * Red-tier confirmation: the operator must TYPE the phrase — `--yes` is
 * deliberately not honored for these (destructive, data-affecting actions).
 */
export async function confirmPhrase(warning: string, phrase: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    say(fmt.red(`Refusing: this action requires interactive confirmation (type "${phrase}") and stdin is not a TTY.`));
    return false;
  }
  say(fmt.red(warning));
  process.stdout.write(`Type ${fmt.bold(phrase)} to continue: `);
  const answer = await readLine();
  return answer.trim() === phrase;
}

/** Yellow-tier confirmation: y/N prompt, or auto-yes with --yes. */
export async function confirmYesNo(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${question} [y/N] `);
  const answer = await readLine();
  return /^y(es)?$/i.test(answer.trim());
}

async function readLine(): Promise<string> {
  for await (const line of console) {
    return line;
  }
  return '';
}

// ── misc ────────────────────────────────────────────────────────────────────

/** Run an async probe with a hard time-box so no single check can hang the CLI. */
export async function timebox<T>(ms: number, run: () => Promise<T>): Promise<T | null> {
  return Promise.race([run().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

export function parseFlags(argv: string[]): { flags: Set<string>; options: Map<string, string>; positional: string[] } {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        options.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
        // Peek: option with a value, unless the next token is another flag.
        // Boolean flags must therefore be listed AFTER positionals or use =.
        options.set(arg.slice(2), argv[++i]!);
      } else {
        flags.add(arg.slice(2));
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, options, positional };
}
