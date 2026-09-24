import { describe, expect, it } from 'bun:test';
import { DEFAULT_SMTP_PROBE_TARGETS, interpretSmtpProbe, ProbeSmtpPayload } from './email';
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
