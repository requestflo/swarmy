/**
 * Terminal session limits, enforced by the CONTROLLER (launch-blocker #7).
 *
 * `TerminalPolicy.idleTimeoutMs` used to reach only the agent (termStart), so
 * an older agent, or a session the agent lost track of, never timed out, and
 * `maxSessionMs` was not enforced anywhere. The data plane is the choke point
 * every byte passes through, so it now enforces both. The agent's own idle
 * timer stays as a second line. Pure: the hub's sweeper calls this with `now`.
 */

export type TerminalLimitReason = 'idle_timeout' | 'max_session';

export interface TerminalLimitInput {
  startedAt: number;
  /** Last keystroke/paste from the browser (output does not count: a `tail -f` left open is idle). */
  lastInputAt: number;
  idleTimeoutMs: number;
  maxSessionMs: number;
  now: number;
}

export function terminalLimitExpired(s: TerminalLimitInput): TerminalLimitReason | null {
  if (s.maxSessionMs > 0 && s.now - s.startedAt >= s.maxSessionMs) return 'max_session';
  if (s.idleTimeoutMs > 0 && s.now - s.lastInputAt >= s.idleTimeoutMs) return 'idle_timeout';
  return null;
}

/** Plain-words reason shown in the browser terminal before the socket closes. */
export function terminalLimitMessage(reason: TerminalLimitReason): string {
  return reason === 'max_session' ? 'session time limit reached' : 'idle timeout';
}

/** How often the hub sweeps live sessions. */
export const TERMINAL_SWEEP_MS = 5_000;
