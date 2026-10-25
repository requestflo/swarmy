/**
 * Email service (epic developer-platform §8): the outbound-port probe.
 *
 * Many clouds (DigitalOcean, and by default AWS, GCP, Azure, Oracle, Hetzner
 * for new accounts, …) block outbound TCP 25, so direct MX delivery from the
 * mail node silently never connects. The controller asks the agent on the node
 * the MTA runs on to open a TCP connection to a few well-known MX hosts and
 * read the SMTP banner; no mail is sent. The result lives in controller memory
 * and drives the plain-words "port 25 is blocked — use a relay" notice.
 */
import { z } from 'zod';
import { CommandId } from './primitives';

export const SmtpProbeTarget = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
});
export type SmtpProbeTarget = z.infer<typeof SmtpProbeTarget>;

export const ProbeSmtpPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  /** Tried in order until one answers; at most 5. */
  targets: z.array(SmtpProbeTarget).min(1).max(5),
  /** Per-target connect+banner budget (default 6s). */
  perTargetMs: z.number().int().min(500).max(20_000).optional(),
});
export type ProbeSmtpPayload = z.infer<typeof ProbeSmtpPayload>;

export const ProbeSmtpMsg = z.object({ type: z.literal('probeSmtp'), payload: ProbeSmtpPayload });
export type ProbeSmtpMsg = z.infer<typeof ProbeSmtpMsg>;

export interface SmtpProbeAttempt {
  host: string;
  port: number;
  /** Connected and got a 220 banner. */
  ok: boolean;
  /** First banner line (truncated), when connected. */
  banner?: string;
  /** timeout | refused | unreachable | dns | other — with the raw message. */
  error?: { kind: 'timeout' | 'refused' | 'unreachable' | 'dns' | 'other'; message: string };
  ms: number;
}

export interface ProbeSmtpResult {
  attempts: SmtpProbeAttempt[];
  /** Any target answered. */
  reachable: boolean;
}

/** Default MX hosts to probe (large, always-on receivers). */
export const DEFAULT_SMTP_PROBE_TARGETS: SmtpProbeTarget[] = [
  { host: 'gmail-smtp-in.l.google.com', port: 25 },
  { host: 'mx1.mail.icloud.com', port: 25 },
  { host: 'mta5.am0.yahoodns.net', port: 25 },
];

/**
 * Read a probe result in plain words. Timeouts on every target (the packets
 * are dropped) is the signature of a provider block; refusals mean something
 * answered, so the port is open on the path.
 */
export function interpretSmtpProbe(r: ProbeSmtpResult): {
  verdict: 'open' | 'blocked' | 'unknown';
  message: string;
} {
  if (r.reachable) return { verdict: 'open', message: 'Outbound port 25 is open: the mail node can deliver directly.' };
  const kinds = new Set(r.attempts.map((a) => a.error?.kind));
  if (kinds.size === 1 && (kinds.has('timeout') || kinds.has('unreachable'))) {
    return {
      verdict: 'blocked',
      message:
        'Outbound port 25 is blocked on the mail node — your cloud provider drops it (DigitalOcean and many others do). ' +
        'Direct delivery cannot work there: send through a relay (any SMTP provider) instead.',
    };
  }
  if (kinds.has('dns')) return { verdict: 'unknown', message: 'The mail node could not resolve the probe hosts; check its DNS.' };
  return { verdict: 'unknown', message: 'The port 25 probe was inconclusive; try again, or use a relay to be safe.' };
}

/** One server's port-25 test, in plain words (board 66: "per-server port-25 test"). */
export type Port25State = 'open' | 'blocked' | 'timeout' | 'unknown';

/**
 * open: the MX answered with its 220 banner. blocked: something on the path
 * refused (a reset, "administratively prohibited", or a non-SMTP banner from
 * an intercepting proxy). timeout: nothing answered, the signature of a
 * provider that silently drops port 25 (DigitalOcean, AWS by default). Pure.
 */
export function port25ServerVerdict(r: ProbeSmtpResult, perTargetMs: number): { state: Port25State; words: string } {
  if (r.reachable) return { state: 'open', words: 'Port 25 is open: this server can deliver mail directly.' };
  const errs = r.attempts.map((a) => a.error?.kind);
  if (errs.length > 0 && errs.every((k) => k === 'timeout')) {
    return {
      state: 'timeout',
      words: `Nothing answered on port 25 within ${Math.round(perTargetMs / 1000)} s. Providers that block mail drop it silently like this; use a relay.`,
    };
  }
  const refused = r.attempts.some((a) => a.error?.kind === 'refused' || a.error?.kind === 'unreachable' || (a.error?.kind === 'other' && a.banner));
  if (refused) return { state: 'blocked', words: 'Your provider blocks outbound mail on this server; use a relay.' };
  if (errs.includes('dns')) return { state: 'unknown', words: 'This server couldn’t look up the mail host. Check its DNS, then test again.' };
  return { state: 'unknown', words: 'The test was inconclusive. Test again, or use a relay to be safe.' };
}
