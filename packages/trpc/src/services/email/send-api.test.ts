/**
 * The send API and report path end to end over a real (test) SQLite store and
 * a real SMTP conversation — our SMTP sink stands in for the MTA, so the test
 * sees exactly what the controller submits (AUTH as the app's own login,
 * envelope, DKIM-less raw message).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:net';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../../context';
import {
  addEmailDomain,
  addSuppression,
  checkEmailDomain,
  createEmailCredential,
  emailOverview,
  emailRecordsForZone,
  listSuppressions,
  saveEmailTemplate,
  setEmailEnabled,
} from '../email.service';
import { dkimRecordValue } from './dkim';
import { parseMime } from './mime';
import { EmailApiError, ingestReport, sendSystemEmail, sendWithApiKey, webhookPayload } from './runtime';
import { startSmtpSink, type SinkMessage } from './smtp';
import { signWebhook, smtpPasswordFor } from './keys';
import { parseReport } from './dsn';
import { readEmailLog, resetEmailMemory } from './store';

const ORG = 'org_mail';
let t: TestDb;
let ctx: OrgContext;
let sink: Server;
const received: SinkMessage[] = [];
const logins: Array<{ u: string; p: string }> = [];
let dbRef: TestDb['db'];

beforeAll(async () => {
  process.env.SWARMY_SECRET_KEY = 'test-vault-key-for-email';
  resetEmailMemory();
  t = await createTestDb();
  dbRef = t.db;
  await t.db.organization.create({ data: { id: ORG, name: 'Mail', slug: 'mail', createdAt: new Date() } });
  // The sink plays the MTA: it accepts any credential whose password is the
  // derived one for a row in the store.
  sink = await startSmtpSink({
    port: 0,
    host: '127.0.0.1',
    auth: (u, p) => {
      logins.push({ u, p });
      return p.length === 32;
    },
    onMessage: (m) => void received.push(m),
  });
  process.env.SWARMY_EMAIL_SMTP_HOST = '127.0.0.1';
  process.env.SWARMY_EMAIL_SMTP_PORT = String((sink.address() as AddressInfo).port);
  ctx = {
    db: t.db,
    hub: {
      liveInventory: () => ({ services: [], containers: [] }),
      nodeInventory: () => [],
      managerNode: () => undefined,
      onlineNodeIds: () => [],
      swarmNodeIdFor: () => undefined,
    },
    activeOrgId: ORG,
    user: { id: 'u1' },
    session: { id: 's' },
    membership: { role: 'owner', orgId: ORG },
  } as unknown as OrgContext;
});

afterAll(async () => {
  sink?.close();
  await t?.close();
});

let apiKey = '';
let credentialId = '';

describe('setup: enable, domain, verification, credential', () => {
  it('enables the service (no swarm here: the MTA converge waits for a manager)', async () => {
    const o = await setEmailEnabled(ctx, true);
    expect(o.enabled).toBe(true);
    expect(o.credentials.map((c) => c.name)).toEqual(['swarmy-system']);
  });

  it('adds a domain with a fresh DKIM key; mail is refused until verified', async () => {
    const d = await addEmailDomain(ctx, { domain: 'Example.com', delivery: 'direct' });
    expect(d.domain).toBe('example.com');
    expect(d.verifiedAt).toBeNull();
    expect(d.dns.mode).toBe('external');
    expect(d.records.find((r) => r.kind === 'dkim')!.value).toStartWith('v=DKIM1; k=rsa; p=MII');
  });

  it('derives the records into a swarmy-dns zone that contains the domain', async () => {
    const recs = await emailRecordsForZone(ctx, 'example.com', []);
    expect(recs.map((r) => `${r.name} ${r.type}`)).toEqual(['swarmy._domainkey TXT', '@ TXT', '_dmarc TXT']);
    expect(await emailRecordsForZone(ctx, 'other.org', [])).toEqual([]);
  });

  it('verifies once DNS shows the DKIM key', async () => {
    const o = await emailOverview(ctx);
    const d = o.domains[0]!;
    const dkim = d.records.find((r) => r.kind === 'dkim')!;
    const checked = await checkEmailDomain(ctx, d.id, {
      txt: async (n) => (n === dkim.name ? [dkim.value] : []),
      addresses: async () => [],
    });
    expect(checked.verifiedAt).not.toBeNull();
    expect(checked.records.find((r) => r.kind === 'dkim')!.status).toBe('ok');
    expect(checked.records.find((r) => r.kind === 'spf')!.status).toBe('missing');
  });

  it('issues a credential once: SMTP login + API key (+ webhook secret)', async () => {
    const issued = await createEmailCredential(ctx, { name: 'shop', webhookUrl: 'https://hooks.shop.test/email' });
    expect(issued.smtp).toMatchObject({ host: 'swarmy-mail', port: 587 });
    expect(issued.smtp.username).toMatch(/^shop\.[a-z0-9_]{1,6}@swarmy$/);
    expect(issued.smtp.password).toBe(smtpPasswordFor(issued.credential.id));
    expect(issued.apiKey).toStartWith('sem_');
    expect(issued.webhookSecret).toStartWith('whsec_');
    apiKey = issued.apiKey;
    credentialId = issued.credential.id;
    const row = await t.db.emailCredential.findUnique({ where: { id: credentialId } });
    expect(row!.smtpPasswordHash).toStartWith('bcrypt:$2a$10$');
    expect(row!.apiKeyHash).not.toContain(apiKey);
  });
});

describe('POST /email/v1/send (sendWithApiKey)', () => {
  it('rejects unknown keys and unverified domains', async () => {
    await expect(sendWithApiKey(dbRef, 'sem_nope', { from: 'a@example.com', to: ['b@x.test'], subject: 's', text: 't' })).rejects.toMatchObject({ status: 401 });
    await expect(sendWithApiKey(dbRef, apiKey, { from: 'a@unverified.test', to: ['b@x.test'], subject: 's', text: 't' })).rejects.toMatchObject({ status: 422, code: 'domain_unverified' });
    await expect(sendWithApiKey(dbRef, apiKey, { from: 'a@example.com', to: [], subject: 's', text: 't' })).rejects.toBeInstanceOf(EmailApiError);
  });

  it('submits to the MTA AS the app’s own SMTP login, with the rendered template', async () => {
    await saveEmailTemplate(ctx, { name: 'welcome', subject: 'Welcome, {{ name }}', html: '<p>Hi {{ name }} — <a href="{{ url }}">start</a></p>' });
    const res = await sendWithApiKey(dbRef, apiKey, {
      from: 'Shop <hello@example.com>',
      to: ['ada@x.test'],
      bcc: ['audit@x.test'],
      template: 'welcome',
      variables: { name: 'Ada <3', url: 'https://shop.test/start' },
    });
    expect(res.accepted).toEqual(['ada@x.test', 'audit@x.test']);
    expect(res.messageId).toMatch(/@example\.com>$/);
    const m = received.at(-1)!;
    const row = await t.db.emailCredential.findUnique({ where: { id: credentialId } });
    expect(m.username).toBe(row!.smtpUsername);
    expect(m.from).toBe('hello@example.com');
    expect(m.to).toEqual(['ada@x.test', 'audit@x.test']);
    const parsed = parseMime(m.raw);
    expect(parsed.headers.get('subject')).toBe('Welcome, Ada <3');
    expect(parsed.headers.get('bcc')).toBeUndefined();
    expect(parsed.parts[1]!.body).toContain('Hi Ada &lt;3');
    const log = await readEmailLog(ORG, {});
    expect(log.source).toBe('memory');
    expect(log.items.filter((e) => e.event === 'queued').map((e) => e.rcpt).sort()).toEqual(['ada@x.test', 'audit@x.test']);
    expect(log.items[0]!.subject).toBe('Welcome, Ada <3');
  });

  it('skips suppressed recipients and refuses when all are suppressed', async () => {
    await addSuppression(ctx, 'Gone@X.test');
    const res = await sendWithApiKey(dbRef, apiKey, { from: 'hello@example.com', to: ['gone@x.test', 'ok@x.test'], subject: 's', text: 't' });
    expect(res.accepted).toEqual(['ok@x.test']);
    expect(res.suppressed).toEqual(['gone@x.test']);
    expect(received.at(-1)!.to).toEqual(['ok@x.test']);
    await expect(sendWithApiKey(dbRef, apiKey, { from: 'hello@example.com', to: ['gone@x.test'], subject: 's', text: 't' })).rejects.toMatchObject({ code: 'all_suppressed' });
  });

  it('a credential limited to other domains may not send from this one', async () => {
    const other = await createEmailCredential(ctx, { name: 'blog', domains: ['blog.test'] });
    await expect(sendWithApiKey(dbRef, other.apiKey, { from: 'a@example.com', to: ['b@x.test'], subject: 's', text: 't' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('bounces and complaints', () => {
  it('a DSN for a sent message suppresses the recipient and posts a signed webhook to the app', async () => {
    const sent = await sendWithApiKey(dbRef, apiKey, { from: 'hello@example.com', to: ['bounce-me@x.test'], subject: 'Receipt', text: 't' });
    const dsn = [
      'From: MAILER-DAEMON@example.com',
      'To: hello@example.com',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
      '',
      '--b',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mail.example.com',
      '',
      'Final-Recipient: rfc822; bounce-me@x.test',
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550 5.1.1 no such user',
      '',
      '--b',
      'Content-Type: text/rfc822-headers',
      '',
      'From: hello@example.com',
      'Subject: Receipt',
      `Message-ID: ${sent.messageId}`,
      '',
      '--b--',
    ].join('\r\n');
    const posted: Array<{ url: string; body: string; sig: string | null }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: String(init.body), sig: new Headers(init.headers).get('x-swarmy-signature') });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const r = await ingestReport(dbRef, dsn, { fetchImpl: fakeFetch });
    expect(r).toEqual({ kind: 'bounce', orgId: ORG, suppressed: ['bounce-me@x.test'], webhook: 'sent' });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe('https://hooks.shop.test/email');
    const body = JSON.parse(posted[0]!.body);
    expect(body).toMatchObject({ type: 'email.bounced', data: { credential: 'shop', messageId: sent.messageId, recipients: [{ address: 'bounce-me@x.test', permanent: true }] } });
    expect(posted[0]!.sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const supp = await listSuppressions(ctx);
    expect(supp.find((s) => s.address === 'bounce-me@x.test')).toMatchObject({ reason: 'bounce', credentialId });
    const log = await readEmailLog(ORG, { event: 'bounced' });
    expect(log.items.map((e) => e.rcpt)).toEqual(['bounce-me@x.test']);
  });

  it('webhook payloads and signatures are stable shapes', () => {
    const r = parseReport('Content-Type: multipart/report; boundary="b"\r\n\r\n--b\r\nContent-Type: message/delivery-status\r\n\r\nX: y\r\n\r\nFinal-Recipient: rfc822; a@b.c\r\nAction: failed\r\nStatus: 5.0.0\r\n\r\n--b--')!;
    expect(webhookPayload(r, 'shop').type).toBe('email.bounced');
    expect(signWebhook('s', '{}', 1)).toBe(`t=1,v1=${require('node:crypto').createHmac('sha256', 's').update('1.{}').digest('hex')}`);
  });

  it('reports that are not DSN/ARF are ignored', async () => {
    expect((await ingestReport(dbRef, 'Subject: hi\r\n\r\nhello')).kind).toBe('ignored');
  });
});

describe('swarmy’s own mail', () => {
  it('sends through the system credential from noreply@<verified domain>', async () => {
    const r = await sendSystemEmail(dbRef, { to: 'new.user@x.test', subject: 'Verify your email', text: 'Click https://swarm.test/verify?t=1' });
    expect(r.sent).toBe(true);
    const m = received.at(-1)!;
    expect(m.username).toMatch(/^swarmy-system\./);
    expect(m.from).toBe('noreply@example.com');
  });

  it('never throws when the service is off', async () => {
    await t.db.emailConfig.update({ where: { orgId: ORG }, data: { enabled: false } });
    expect(await sendSystemEmail(dbRef, { to: 'x@y.z', subject: 's', text: 't' })).toEqual({ sent: false, reason: 'email service off' });
    await t.db.emailConfig.update({ where: { orgId: ORG }, data: { enabled: true } });
  });
});

void dkimRecordValue;
