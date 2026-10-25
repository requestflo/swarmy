import { describe, expect, it } from 'bun:test';
import { AGENT_CAPABILITIES, agentSupports } from './capabilities';
import { DEFAULT_SMTP_PROBE_TARGETS, interpretSmtpProbe, port25ServerVerdict, ProbeSmtpMsg, ProbeSmtpPayload } from './email';
import { DEFAULT_COMMAND_TIMEOUTS } from './constants';
import { parseControllerEnvelope } from './messages';

const CMD_ID = '00000000-0000-4000-8000-000000000025';

describe('probeSmtp (email service port-25 probe)', () => {
  it('round-trips through the controller envelope', () => {
    const env = parseControllerEnvelope({
      v: 1,
      id: CMD_ID,
      ts: 1,
      type: 'probeSmtp',
      payload: { commandId: CMD_ID, targets: DEFAULT_SMTP_PROBE_TARGETS, perTargetMs: 6000 },
    });
    expect(env.type).toBe('probeSmtp');
    if (env.type === 'probeSmtp') expect(env.payload.targets[0]).toEqual({ host: 'gmail-smtp-in.l.google.com', port: 25 });
  });

  it('bounds the target list and the per-target budget', () => {
    expect(ProbeSmtpPayload.safeParse({ commandId: CMD_ID, targets: [] }).success).toBe(false);
    expect(ProbeSmtpPayload.safeParse({ commandId: CMD_ID, targets: Array(6).fill({ host: 'a', port: 25 }) }).success).toBe(false);
    expect(ProbeSmtpPayload.safeParse({ commandId: CMD_ID, targets: [{ host: 'a', port: 25 }], perTargetMs: 60_000 }).success).toBe(false);
  });

  it('has a timeout that covers every target', () => {
    expect(DEFAULT_COMMAND_TIMEOUTS.probeSmtp).toBeGreaterThanOrEqual(5 * 6000);
  });

  it('reads results in plain words: all-timeouts is a provider block', () => {
    const t = (kind: 'timeout' | 'refused' | 'dns') => ({ host: 'h', port: 25, ok: false, ms: 6000, error: { kind, message: kind } });
    expect(interpretSmtpProbe({ reachable: true, attempts: [{ host: 'h', port: 25, ok: true, ms: 40, banner: '220 mx' }] }).verdict).toBe('open');
    const blocked = interpretSmtpProbe({ reachable: false, attempts: [t('timeout'), t('timeout'), t('timeout')] });
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.message).toContain('relay');
    expect(interpretSmtpProbe({ reachable: false, attempts: [t('timeout'), t('refused')] }).verdict).toBe('unknown');
    expect(interpretSmtpProbe({ reachable: false, attempts: [t('dns')] }).verdict).toBe('unknown');
  });
});

describe('per-server port-25 test (board 66)', () => {
  const a = (kind?: 'timeout' | 'refused' | 'unreachable' | 'dns' | 'other', banner?: string) => ({
    host: 'gmail-smtp-in.l.google.com',
    port: 25,
    ok: !kind,
    ms: 40,
    ...(banner ? { banner } : {}),
    ...(kind ? { error: { kind, message: kind } } : {}),
  });

  it('says open, blocked or timeout in plain words', () => {
    expect(port25ServerVerdict({ reachable: true, attempts: [a(undefined, '220 mx')] }, 5000).state).toBe('open');
    const blocked = port25ServerVerdict({ reachable: false, attempts: [a('refused')] }, 5000);
    expect(blocked).toEqual({ state: 'blocked', words: 'Your provider blocks outbound mail on this server; use a relay.' });
    expect(port25ServerVerdict({ reachable: false, attempts: [a('unreachable')] }, 5000).state).toBe('blocked');
    // An intercepting proxy answering with a non-SMTP banner is a block too.
    expect(port25ServerVerdict({ reachable: false, attempts: [a('other', '554 no SMTP here')] }, 5000).state).toBe('blocked');
    const timeout = port25ServerVerdict({ reachable: false, attempts: [a('timeout')] }, 5000);
    expect(timeout.state).toBe('timeout');
    expect(timeout.words).toContain('within 5 s');
    expect(port25ServerVerdict({ reachable: false, attempts: [a('dns')] }, 5000).state).toBe('unknown');
    expect(port25ServerVerdict({ reachable: false, attempts: [] }, 5000).state).toBe('unknown');
  });

  it('a one-target probe parses and its message keeps the probeSmtp discriminant', () => {
    const msg = ProbeSmtpMsg.parse({ type: 'probeSmtp', payload: { commandId: CMD_ID, targets: [DEFAULT_SMTP_PROBE_TARGETS[0]], perTargetMs: 5000 } });
    expect(ProbeSmtpMsg.parse(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
    expect(ProbeSmtpMsg.safeParse({ ...msg, type: 'probePort' }).success).toBe(false);
  });

  it('is advertised as a capability, never assumed of an agent that predates the list', () => {
    expect(AGENT_CAPABILITIES).toContain('probeSmtp');
    expect(agentSupports(undefined, 'probeSmtp')).toBe(false);
  });
});
