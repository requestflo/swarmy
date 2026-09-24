/**
 * Email service, local end to end: the REAL MTA container (maddy, the pinned
 * BOM image) running swarmy's own render, a Mailpit catcher as the smarthost,
 * and the controller's SMTP bounce hook on the host. Proves:
 *   - per-app SMTP AUTH + the sender-domain rule,
 *   - DKIM: what arrives verifies against the key swarmy publishes,
 *   - suppression rejects at submission,
 *   - an undeliverable route produces a DSN at the bounce hook that the
 *     parser attributes to the recipient,
 *   - the MTA's log lines turn into send-log events.
 *
 * Needs Docker: run with `SWARMY_EMAIL_E2E=1 bun test src/services/email/mta.e2e.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dkimVerify, generateDkimKey } from './dkim';
import { parseReport } from './dsn';
import { MaddyLogTracker } from './log';
import { MADDY_IMAGE, maddyBcrypt, maddyBundle } from './maddy';
import { buildMessage } from './mime';
import { SmtpError, smtpSubmit, startSmtpSink, type SinkMessage } from './smtp';

const RUN = process.env.SWARMY_EMAIL_E2E === '1';
const MAILPIT_IMAGE = 'axllent/mailpit:v1.27';
const tag = `swarmy-email-e2e-${process.pid}`;
const NET = tag;
const MAILPIT = `${tag}-mailpit`;
const MADDY = `${tag}-maddy`;

function docker(...args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function hostPort(container: string, port: number): number {
  const out = docker('port', container, `${port}/tcp`);
  return Number(out.split('\n')[0]!.split(':').pop());
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // retry
    }
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

const key = generateDkimKey();
const bounceKey = generateDkimKey();
const APP_USER = 'shop.e2e@swarmy';
const APP_PASS = 'e2e-app-password-0123456789abcd';
const dsns: SinkMessage[] = [];
let sink: Server;
let dir: string;
let submitPort = 0;
let mailpitApi = '';

describe.skipIf(!RUN)('email MTA end to end (maddy + Mailpit)', () => {
  beforeAll(async () => {
    sink = await startSmtpSink({
      port: 0,
      host: '0.0.0.0',
      auth: (u, p) => u === 'maddy' && p === 'hook-token',
      onMessage: (m) => void dsns.push(m),
    });
    const hookPort = (sink.address() as AddressInfo).port;
    const hash = maddyBcrypt(await Bun.password.hash(APP_PASS, { algorithm: 'bcrypt', cost: 10 }));
    const bundle = maddyBundle({
      hostname: 'mail.example.test',
      domains: [
        // Relay route → Mailpit (the catcher plays "any SMTP provider").
        { domain: 'example.test', selector: 'swarmy', dkimPrivateKeyPem: key.privateKeyPem, relay: { host: MAILPIT, port: 1025, security: 'none' } },
        // A route whose relay never answers → the MTA gives up → DSN.
        { domain: 'bounce.test', selector: 'swarmy', dkimPrivateKeyPem: bounceKey.privateKeyPem, relay: { host: `${tag}-nowhere`, port: 1025, security: 'none' } },
      ],
      users: [{ username: APP_USER, passwordHash: hash, domains: ['example.test', 'bounce.test'] }],
      suppressed: ['gone@dest.test'],
      bounceHook: { host: 'host.docker.internal', port: hookPort, username: 'maddy', password: 'hook-token' },
    });
    dir = mkdtempSync(join(tmpdir(), 'swarmy-mail-e2e-'));
    chmodSync(dir, 0o755);
    const mounts: string[] = [];
    for (const s of bundle.all) {
      writeFileSync(join(dir, s.target), s.value);
      chmodSync(join(dir, s.target), 0o644);
      mounts.push('-v', `${join(dir, s.target)}:/run/secrets/${s.target}:ro`);
    }
    spawnSync('docker', ['rm', '-f', MAILPIT, MADDY]);
    docker('network', 'create', NET);
    docker('run', '-d', '--name', MAILPIT, '--network', NET, '-p', '127.0.0.1::8025', MAILPIT_IMAGE);
    docker(
      'run', '-d', '--name', MADDY, '--network', NET, '-p', '127.0.0.1::587',
      '--add-host', 'host.docker.internal:host-gateway',
      ...mounts,
      MADDY_IMAGE, '-config', '/run/secrets/maddy.conf', 'run',
    );
    submitPort = hostPort(MADDY, 587);
    mailpitApi = `http://127.0.0.1:${hostPort(MAILPIT, 8025)}/api/v1`;
    await waitFor(async () => ((await fetch(`${mailpitApi}/messages`)).ok ? true : undefined));
    await waitFor(async () => (spawnSync('docker', ['logs', MADDY], { encoding: 'utf8' }).stderr.includes('server started') ? true : undefined));
  }, 120_000);

  afterAll(() => {
    sink?.close();
    spawnSync('docker', ['rm', '-f', MAILPIT, MADDY]);
    spawnSync('docker', ['network', 'rm', NET]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const submit = (from: string, to: string[], subject: string, pass = APP_PASS) =>
    smtpSubmit({
      host: '127.0.0.1',
      port: submitPort,
      username: APP_USER,
      password: pass,
      from,
      to,
      raw: buildMessage({ from, to, subject, text: `${subject} body`, messageIdDomain: from.split('@')[1]! }).raw,
    });

  it('delivers through the relay with a DKIM signature that verifies against the published key', async () => {
    const res = await submit('hello@example.test', ['ada@dest.test'], 'E2E hello');
    expect(res.response).toStartWith('250');
    const raw = await waitFor(async () => {
      const list = (await (await fetch(`${mailpitApi}/messages`)).json()) as { messages: Array<{ ID: string; Subject: string }> };
      const m = list.messages.find((x) => x.Subject === 'E2E hello');
      return m ? await (await fetch(`${mailpitApi}/message/${m.ID}/raw`)).text() : undefined;
    });
    // The key the domain's DNS record carries (dkimRecordValue(key.publicKeyB64)).
    const verdict = await dkimVerify(raw, { lookup: async (name) => (name === 'swarmy._domainkey.example.test' ? [`v=DKIM1; k=rsa; p=${key.publicKeyB64}`] : []) });
    expect(verdict).toEqual({ status: 'pass', domain: 'example.test', selector: 'swarmy' });
  }, 30_000);

  it('refuses a wrong password, a foreign sender domain and a suppressed recipient', async () => {
    await expect(submit('hello@example.test', ['a@dest.test'], 'x', 'wrong-password')).rejects.toBeInstanceOf(SmtpError);
    await expect(submit('hello@elsewhere.test', ['a@dest.test'], 'x')).rejects.toMatchObject({ code: 501 });
    await expect(submit('hello@example.test', ['gone@dest.test'], 'x')).rejects.toMatchObject({ code: 550 });
  });

  it('an undeliverable message comes back as a DSN at the bounce hook', async () => {
    await submit('hello@bounce.test', ['nobody@dest.test'], 'E2E bounce');
    const dsn = await waitFor(async () => dsns.find((d) => d.raw.includes('E2E bounce')), 60_000);
    expect(dsn.username).toBe('maddy');
    const report = parseReport(dsn.raw)!;
    expect(report.kind).toBe('bounce');
    expect(report.originalSender).toBe('hello@bounce.test');
    expect(report.recipients.map((r) => [r.address, r.severity])).toEqual([['nobody@dest.test', 'hard']]);
    expect(report.mtaMessageId).toMatch(/^[0-9a-f]+$/);
  }, 90_000);

  it('the MTA log becomes send-log events attributed to the credential', () => {
    const r = spawnSync('docker', ['logs', MADDY], { encoding: 'utf8' });
    const t = new MaddyLogTracker('org');
    const events = `${r.stdout}\n${r.stderr}`.split('\n').flatMap((l) => t.feed(l));
    expect(events.some((e) => e.event === 'delivered' && e.rcpt === 'ada@dest.test' && e.credential === APP_USER)).toBe(true);
    expect(events.some((e) => e.event === 'rejected' && e.rcpt === 'gone@dest.test')).toBe(true);
    expect(events.some((e) => e.event === 'failed' && e.rcpt === 'nobody@dest.test')).toBe(true);
  });
});
