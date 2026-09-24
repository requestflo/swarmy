import { describe, expect, it } from 'bun:test';
import { parseReport, suppressionsFrom } from './dsn';
import { MADDY_DSN } from './fixtures.test-data';

const RFC3464 = [
  'From: MAILER-DAEMON@mx.example.org',
  'To: noreply@example.com',
  'Subject: Delivery Status Notification (Failure)',
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain',
  '',
  'Your message could not be delivered.',
  '--b1',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.org',
  '',
  'Final-Recipient: rfc822; gone@example.org',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 <gone@example.org>: user unknown',
  '',
  'Final-Recipient: rfc822; busy@example.org',
  'Action: delayed',
  'Status: 4.2.2',
  'Diagnostic-Code: smtp; 452 4.2.2 mailbox full',
  '',
  '--b1',
  'Content-Type: text/rfc822-headers',
  '',
  'From: Shop <noreply@example.com>',
  'To: gone@example.org, busy@example.org',
  'Subject: =?UTF-8?B?WW91ciBvcmRlciDinJM=?=',
  'Message-ID: <abc123@example.com>',
  '',
  '--b1--',
  '',
].join('\r\n');

const ARF = [
  'From: fbl@isp.example',
  'To: abuse@example.com',
  'Subject: Complaint',
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=feedback-report; boundary="arf"',
  '',
  '--arf',
  'Content-Type: text/plain',
  '',
  'This is an email abuse report.',
  '--arf',
  'Content-Type: message/feedback-report',
  '',
  'Feedback-Type: abuse',
  'User-Agent: SomeFBL/1.0',
  'Version: 1',
  'Original-Mail-From: <noreply@example.com>',
  'Original-Rcpt-To: <Angry@isp.example>',
  'Reporting-MTA: dns; fbl.isp.example',
  '',
  '--arf',
  'Content-Type: message/rfc822',
  '',
  'From: noreply@example.com',
  'To: angry@isp.example',
  'Subject: Weekly news',
  'Message-ID: <news-1@example.com>',
  '',
  'body',
  '--arf--',
  '',
].join('\r\n');

describe('parseReport — RFC 3464 DSN', () => {
  it('reads per-recipient status and classifies hard vs soft', () => {
    const r = parseReport(RFC3464)!;
    expect(r.kind).toBe('bounce');
    expect(r.reportingMta).toBe('mx.example.org');
    expect(r.originalMessageId).toBe('abc123@example.com');
    expect(r.originalSender).toBe('noreply@example.com');
    expect(r.originalSubject).toBe('Your order ✓');
    expect(r.recipients).toEqual([
      { address: 'gone@example.org', action: 'failed', status: '5.1.1', diagnostic: 'smtp; 550 5.1.1 <gone@example.org>: user unknown', severity: 'hard' },
      { address: 'busy@example.org', action: 'delayed', status: '4.2.2', diagnostic: 'smtp; 452 4.2.2 mailbox full', severity: 'soft' },
    ]);
  });

  it('only hard failures reach the suppression list', () => {
    expect(suppressionsFrom(parseReport(RFC3464)!)).toEqual([
      { address: 'gone@example.org', reason: 'bounce', detail: 'smtp; 550 5.1.1 <gone@example.org>: user unknown' },
    ]);
  });

  it('a delay-only report is a delay, and suppresses nothing', () => {
    const delayed = RFC3464.replace('Action: failed', 'Action: delayed').replace('Status: 5.1.1', 'Status: 4.4.7');
    const r = parseReport(delayed)!;
    expect(r.kind).toBe('delay');
    expect(suppressionsFrom(r)).toEqual([]);
  });

  it('a failed action with a 4.x.x status stays soft', () => {
    const r = parseReport(RFC3464.replace('Status: 5.1.1', 'Status: 4.7.0'))!;
    expect(r.recipients[0]!.severity).toBe('soft');
  });
});

describe('parseReport — the DSN maddy generates', () => {
  it('reads the recipient, maddy queue id and the original headers', () => {
    const r = parseReport(MADDY_DSN)!;
    expect(r.kind).toBe('bounce');
    expect(r.mtaMessageId).toMatch(/^[0-9a-f]{8}$/);
    expect(r.originalSender).toBe('noreply@example.test');
    expect(r.originalSubject).toBe('Welcome aboard');
    expect(r.originalMessageId).toMatch(/@example\.test$/);
    expect(r.recipients).toHaveLength(1);
    expect(r.recipients[0]).toMatchObject({ address: 'nobody@dest.test', action: 'failed', status: '5.0.0', severity: 'hard' });
  });
});

describe('parseReport — ARF complaints (RFC 5965)', () => {
  it('reads the complaining recipient and feedback type', () => {
    const r = parseReport(ARF)!;
    expect(r.kind).toBe('complaint');
    expect(r.feedbackType).toBe('abuse');
    expect(r.originalSender).toBe('noreply@example.com');
    expect(r.originalMessageId).toBe('news-1@example.com');
    expect(r.recipients.map((x) => x.address)).toEqual(['angry@isp.example']);
    expect(suppressionsFrom(r)).toEqual([{ address: 'angry@isp.example', reason: 'complaint', detail: 'abuse' }]);
  });
});

describe('parseReport — not a report', () => {
  it('returns null for ordinary mail', () => {
    expect(parseReport('From: a@b.c\r\nSubject: hi\r\n\r\nhello')).toBeNull();
  });
});
