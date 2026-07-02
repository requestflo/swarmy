import { describe, expect, it } from 'bun:test';
import {
  NOTIFY_MAX_ATTEMPTS,
  buildMailgunRequest,
  buildPostmarkRequest,
  buildResendRequest,
  extractProviderId,
  isBounceTarget,
  notifyBackoffMs,
  parseBounce,
  parseProviderCreds,
  type MailInput,
} from './notification-dispatch';

const mail: MailInput = {
  from: 'swarmy <noreply@x.com>',
  to: 'ops@x.com',
  subject: 'Deploy finished',
  text: 'All green.',
  html: '<p>All green.</p>',
};

describe('buildResendRequest', () => {
  it('builds the JSON POST with a bearer key', () => {
    const req = buildResendRequest('re_123', mail);
    expect(req.url).toBe('https://api.resend.com/emails');
    expect(req.headers.authorization).toBe('Bearer re_123');
    expect(JSON.parse(req.body)).toEqual({
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      text: 'All green.',
      html: '<p>All green.</p>',
    });
  });

  it('omits missing body parts', () => {
    const req = buildResendRequest('re_1', { ...mail, html: null });
    expect(JSON.parse(req.body)).not.toHaveProperty('html');
  });
});

describe('buildPostmarkRequest', () => {
  it('builds the Postmark shape with the server-token header', () => {
    const req = buildPostmarkRequest('pm_tok', mail);
    expect(req.url).toBe('https://api.postmarkapp.com/email');
    expect(req.headers['x-postmark-server-token']).toBe('pm_tok');
    expect(JSON.parse(req.body)).toEqual({
      From: mail.from,
      To: mail.to,
      Subject: mail.subject,
      TextBody: 'All green.',
      HtmlBody: '<p>All green.</p>',
    });
  });
});

describe('buildMailgunRequest', () => {
  const creds = {
    kind: 'mailgun' as const,
    apiKey: 'key-1',
    domain: 'mg.x.com',
    baseUrl: 'https://api.mailgun.net',
  };

  it('builds the form POST against the domain path with basic auth', () => {
    const req = buildMailgunRequest(creds, mail);
    expect(req.url).toBe('https://api.mailgun.net/v3/mg.x.com/messages');
    expect(req.headers.authorization).toBe(
      `Basic ${Buffer.from('api:key-1').toString('base64')}`,
    );
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(req.body);
    expect(form.get('from')).toBe(mail.from);
    expect(form.get('to')).toBe(mail.to);
    expect(form.get('subject')).toBe(mail.subject);
    expect(form.get('text')).toBe('All green.');
    expect(form.get('html')).toBe('<p>All green.</p>');
  });

  it('respects a regional base url and trailing slashes', () => {
    const req = buildMailgunRequest({ ...creds, baseUrl: 'https://api.eu.mailgun.net/' }, mail);
    expect(req.url).toBe('https://api.eu.mailgun.net/v3/mg.x.com/messages');
  });
});

describe('extractProviderId', () => {
  it('reads resend/mailgun `id` and postmark `MessageID`', () => {
    expect(extractProviderId('resend', { id: 'abc' })).toBe('abc');
    expect(extractProviderId('postmark', { MessageID: 'pm-1' })).toBe('pm-1');
    expect(extractProviderId('mailgun', { id: '<mg-1@mg.x.com>' })).toBe('mg-1@mg.x.com');
    expect(extractProviderId('resend', {})).toBeNull();
    expect(extractProviderId('resend', null)).toBeNull();
  });
});

describe('notifyBackoffMs', () => {
  it('walks 1m → 5m → 15m and clamps', () => {
    expect(notifyBackoffMs(1)).toBe(60_000);
    expect(notifyBackoffMs(2)).toBe(300_000);
    expect(notifyBackoffMs(3)).toBe(900_000);
    expect(notifyBackoffMs(99)).toBe(900_000);
    expect(NOTIFY_MAX_ATTEMPTS).toBe(4);
  });
});

describe('parseBounce — provider webhook payloads', () => {
  it('resend bounce', () => {
    const b = parseBounce(
      JSON.stringify({
        type: 'email.bounced',
        data: { email_id: 're-msg-1', bounce: { message: 'mailbox full' } },
      }),
    );
    expect(b).toEqual({ providerId: 're-msg-1', reason: 'mailbox full' });
  });

  it('resend delivered event is NOT a bounce', () => {
    expect(
      parseBounce(JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } })),
    ).toBeNull();
  });

  it('postmark bounce + spam complaint', () => {
    expect(
      parseBounce(
        JSON.stringify({ RecordType: 'Bounce', MessageID: 'pm-1', Description: 'hard bounce' }),
      ),
    ).toEqual({ providerId: 'pm-1', reason: 'hard bounce' });
    expect(
      parseBounce(JSON.stringify({ RecordType: 'SpamComplaint', MessageID: 'pm-2' })),
    ).toEqual({ providerId: 'pm-2', reason: null });
  });

  it('mailgun permanent failure (angle-bracketed message-id stripped)', () => {
    const b = parseBounce(
      JSON.stringify({
        'event-data': {
          event: 'failed',
          severity: 'permanent',
          message: { headers: { 'message-id': '<mg-1@mg.x.com>' } },
          'delivery-status': { description: 'user unknown' },
        },
      }),
    );
    expect(b).toEqual({ providerId: 'mg-1@mg.x.com', reason: 'user unknown' });
  });

  it('generic shape', () => {
    expect(parseBounce(JSON.stringify({ event: 'bounce', providerId: 'x-1' }))).toEqual({
      providerId: 'x-1',
      reason: null,
    });
  });

  it('junk bodies return null', () => {
    expect(parseBounce('not json')).toBeNull();
    expect(parseBounce('42')).toBeNull();
    expect(parseBounce('{}')).toBeNull();
  });
});

describe('isBounceTarget + creds mirror', () => {
  it('recognizes only the internal notifications.bounce marker', () => {
    expect(isBounceTarget({ kind: 'internal', handler: 'notifications.bounce' })).toBe(true);
    expect(isBounceTarget({ kind: 'forward', url: 'https://x.com' })).toBe(false);
    expect(isBounceTarget(null)).toBe(false);
  });

  it('parses provider creds like the service codec', () => {
    expect(parseProviderCreds({ kind: 'resend', apiKey: 're_1' })).toEqual({
      kind: 'resend',
      apiKey: 're_1',
    });
    expect(parseProviderCreds({ kind: 'smtp', host: 'h' })).toMatchObject({
      kind: 'smtp',
      port: 587,
    });
    expect(parseProviderCreds({ kind: 'nope' })).toBeNull();
  });
});
