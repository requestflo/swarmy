import { describe, expect, it } from 'bun:test';
import {
  MAILGUN_DEFAULT_BASE,
  bounceEndpointSlug,
  credsSummary,
  deliveryStatusFromDb,
  mergeCreds,
  parseProviderCreds,
  providerFromDb,
} from './notifications.service';

describe('parseProviderCreds — configEnc JSON codec', () => {
  it('parses smtp with defaults', () => {
    expect(parseProviderCreds({ kind: 'smtp', host: 'mail.example.com' })).toEqual({
      kind: 'smtp',
      host: 'mail.example.com',
      port: 587,
      secure: false,
      user: null,
      pass: null,
    });
  });

  it('parses each REST provider', () => {
    expect(parseProviderCreds({ kind: 'resend', apiKey: 're_1' })).toEqual({
      kind: 'resend',
      apiKey: 're_1',
    });
    expect(parseProviderCreds({ kind: 'postmark', serverToken: 'pm_1' })).toEqual({
      kind: 'postmark',
      serverToken: 'pm_1',
    });
    expect(parseProviderCreds({ kind: 'mailgun', apiKey: 'k', domain: 'mg.x.com' })).toEqual({
      kind: 'mailgun',
      apiKey: 'k',
      domain: 'mg.x.com',
      baseUrl: MAILGUN_DEFAULT_BASE,
    });
  });

  it('rejects malformed blobs', () => {
    expect(parseProviderCreds(null)).toBeNull();
    expect(parseProviderCreds('smtp')).toBeNull();
    expect(parseProviderCreds({ kind: 'smtp' })).toBeNull();
    expect(parseProviderCreds({ kind: 'resend' })).toBeNull();
    expect(parseProviderCreds({ kind: 'mailgun', apiKey: 'k' })).toBeNull();
    expect(parseProviderCreds({ kind: 'sendgrid', apiKey: 'x' })).toBeNull();
  });
});

describe('credsSummary — never leaks secrets', () => {
  it('smtp: host/port/mode/user only — no password', () => {
    const s = credsSummary({
      kind: 'smtp',
      host: 'mail.x.com',
      port: 465,
      secure: true,
      user: 'mailer',
      pass: 'hunter2',
    });
    expect(s).toEqual({ host: 'mail.x.com', port: '465', secure: 'tls', user: 'mailer' });
    expect(JSON.stringify(s)).not.toContain('hunter2');
  });

  it('mailgun: domain only — no api key', () => {
    const s = credsSummary({
      kind: 'mailgun',
      apiKey: 'key-secret',
      domain: 'mg.x.com',
      baseUrl: MAILGUN_DEFAULT_BASE,
    });
    expect(s).toEqual({ domain: 'mg.x.com' });
    expect(JSON.stringify(s)).not.toContain('key-secret');
  });

  it('mailgun: surfaces a non-default base url (EU region)', () => {
    const s = credsSummary({
      kind: 'mailgun',
      apiKey: 'k',
      domain: 'mg.x.com',
      baseUrl: 'https://api.eu.mailgun.net',
    });
    expect(s.baseUrl).toBe('https://api.eu.mailgun.net');
  });

  it('resend/postmark: nothing but the configured flag elsewhere', () => {
    expect(credsSummary({ kind: 'resend', apiKey: 're_x' })).toEqual({});
    expect(credsSummary({ kind: 'postmark', serverToken: 'pm_x' })).toEqual({});
    expect(credsSummary(null)).toEqual({});
  });
});

describe('mergeCreds — write-only secrets keep stored values when omitted', () => {
  const base = { fromAddress: 'noreply@x.com' };

  it('keeps the stored resend key when the form omits it', () => {
    const merged = mergeCreds(
      { provider: 'resend', resend: {}, ...base },
      { kind: 'resend', apiKey: 're_stored' },
    );
    expect(merged).toEqual({ kind: 'resend', apiKey: 're_stored' });
  });

  it('replaces the key when a new one is typed', () => {
    const merged = mergeCreds(
      { provider: 'resend', resend: { apiKey: 're_new' }, ...base },
      { kind: 'resend', apiKey: 're_stored' },
    );
    expect(merged).toEqual({ kind: 'resend', apiKey: 're_new' });
  });

  it('throws when enabling a provider with no key at all', () => {
    expect(() => mergeCreds({ provider: 'resend', ...base }, null)).toThrow();
    expect(() =>
      mergeCreds({ provider: 'postmark', ...base }, { kind: 'resend', apiKey: 're_x' }),
    ).toThrow();
  });

  it('smtp: keeps the stored password across host edits', () => {
    const merged = mergeCreds(
      {
        provider: 'smtp',
        smtp: { host: 'mail2.x.com', port: 2525, secure: false },
        ...base,
      },
      { kind: 'smtp', host: 'mail.x.com', port: 587, secure: false, user: 'u', pass: 'stored' },
    );
    expect(merged).toEqual({
      kind: 'smtp',
      host: 'mail2.x.com',
      port: 2525,
      secure: false,
      user: 'u',
      pass: 'stored',
    });
  });

  it('mailgun: keeps stored key, applies new domain, defaults base url', () => {
    const merged = mergeCreds(
      { provider: 'mailgun', mailgun: { domain: 'mg2.x.com' }, ...base },
      { kind: 'mailgun', apiKey: 'k1', domain: 'mg.x.com', baseUrl: MAILGUN_DEFAULT_BASE },
    );
    expect(merged).toEqual({
      kind: 'mailgun',
      apiKey: 'k1',
      domain: 'mg2.x.com',
      baseUrl: MAILGUN_DEFAULT_BASE,
    });
  });

  it('switching provider ignores the other provider’s stored creds', () => {
    expect(() =>
      mergeCreds(
        { provider: 'mailgun', mailgun: { domain: 'mg.x.com' }, ...base },
        { kind: 'resend', apiKey: 're_x' },
      ),
    ).toThrow(); // no mailgun key to inherit
  });
});

describe('enum codecs + bounce slug', () => {
  it('maps db enums to wire values (defensive defaults)', () => {
    expect(providerFromDb('RESEND')).toBe('resend');
    expect(providerFromDb('SMTP')).toBe('smtp');
    expect(providerFromDb('junk')).toBe('smtp');
    expect(deliveryStatusFromDb('SENT')).toBe('sent');
    expect(deliveryStatusFromDb('BOUNCED')).toBe('bounced');
    expect(deliveryStatusFromDb('junk')).toBe('queued');
  });

  it('bounce endpoint slug is org-scoped and stable', () => {
    expect(bounceEndpointSlug('org1')).toBe('notify-bounces-org1');
  });
});
