/**
 * Email service — the data plane (no session context: called from the
 * controller's HTTP routes, the bounce hook and swarmy's own mail paths).
 *
 *   sendWithApiKey   POST /email/v1/send — per-app API key → template render →
 *                    MIME → submitted to the MTA AS the app's own SMTP login
 *   ingestReport     a DSN/ARF report (bounce hook or POST /email/v1/inbound)
 *                    → suppression list + send log + the app's webhook
 *   sendSystemEmail  swarmy's own mail (invites, verification, alerts)
 */
import { decryptSecret } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import { addressDomain, bareAddress } from './dns';
import { domainsOf } from './deploy';
import { parseReport, suppressionsFrom, type ParsedReport } from './dsn';
import { signWebhook, sha256, smtpPasswordFor, SYSTEM_CREDENTIAL } from './keys';
import { emptyEvent, type EmailEvent } from './log';
import { MAIL_HOST, SUBMISSION_PORT } from './maddy';
import { buildMessage, renderTemplate } from './mime';
import { SmtpError, smtpSubmit } from './smtp';
import { recordEmailEvents, rememberSent, sentBy, trackerFor } from './store';

export const MAX_RECIPIENTS = 50;
export const MAX_BODY_BYTES = 512 * 1024;

/** Where the controller submits: the MTA on the control overlay (override for dev/e2e). */
export function mtaEndpoint(): { host: string; port: number } {
  return {
    host: process.env.SWARMY_EMAIL_SMTP_HOST || MAIL_HOST,
    port: Number(process.env.SWARMY_EMAIL_SMTP_PORT) || SUBMISSION_PORT,
  };
}

/** Public base of the send API (apps get it as EMAIL_API_URL). */
export function emailApiUrl(): string {
  const base = (process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3021').replace(/\/+$/, '');
  return `${base}/email/v1`;
}

export class EmailApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 422 | 429 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type CredentialRow = NonNullable<Awaited<ReturnType<DB['emailCredential']['findFirst']>>>;

export interface SendInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
  template?: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  source?: EmailEvent['source'];
}

export interface SendResult {
  /** RFC 5322 Message-ID of the accepted message. */
  messageId: string;
  accepted: string[];
  /** Not sent: on the suppression list. */
  suppressed: string[];
  /** Refused by the MTA at submission. */
  rejected: Array<{ address: string; reason: string }>;
  response: string;
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

function normaliseList(v: string[] | undefined, what: string): string[] {
  const out = (v ?? []).map((a) => a.trim()).filter(Boolean);
  for (const a of out) if (!EMAIL_RE.test(bareAddress(a))) throw new EmailApiError(400, 'invalid_address', `${what}: "${a}" is not an email address`);
  return out;
}

/** Validate + render + submit as one credential. The HTTP API and the controller's own mail both end here. */
export async function sendAsCredential(db: DB, cred: CredentialRow, input: SendInput): Promise<SendResult> {
  const orgId = cred.orgId;
  const cfg = await db.emailConfig.findUnique({ where: { orgId } });
  if (!cfg?.enabled) throw new EmailApiError(503, 'email_off', 'The email service is turned off.');
  if (cred.disabled) throw new EmailApiError(403, 'credential_disabled', 'This email credential is disabled.');

  const fromDomain = addressDomain(input.from ?? '');
  if (!fromDomain || !EMAIL_RE.test(bareAddress(input.from))) throw new EmailApiError(400, 'invalid_from', '`from` must be an address at one of your verified domains.');
  const domain = await db.emailDomain.findFirst({ where: { orgId, domain: fromDomain } });
  if (!domain?.verifiedAt) throw new EmailApiError(422, 'domain_unverified', `${fromDomain} is not a verified sending domain. Add it under Email and publish its DNS records.`);
  const allowed = domainsOf(cred.domains);
  if (allowed.length && !allowed.includes(fromDomain)) throw new EmailApiError(403, 'domain_not_allowed', `This credential may not send from ${fromDomain}.`);

  const to = normaliseList(input.to, 'to');
  const cc = normaliseList(input.cc, 'cc');
  const bcc = normaliseList(input.bcc, 'bcc');
  const all = [...to, ...cc, ...bcc];
  if (!all.length) throw new EmailApiError(400, 'no_recipients', 'Give at least one recipient in `to`.');
  if (all.length > MAX_RECIPIENTS) throw new EmailApiError(400, 'too_many_recipients', `At most ${MAX_RECIPIENTS} recipients per message.`);

  let subject = input.subject ?? '';
  let text = input.text;
  let html = input.html;
  if (input.template) {
    const tpl = await db.emailTemplate.findFirst({ where: { orgId, name: input.template } });
    if (!tpl) throw new EmailApiError(404, 'template_not_found', `No template named "${input.template}".`);
    const vars = input.variables ?? {};
    subject = renderTemplate(input.subject ?? tpl.subject, vars, 'text').value;
    html = tpl.html ? renderTemplate(tpl.html, vars, 'html').value : undefined;
    text = tpl.text ? renderTemplate(tpl.text, vars, 'text').value : undefined;
  }
  if (!subject.trim()) throw new EmailApiError(400, 'no_subject', 'Give a `subject` (or a template).');
  if (!text?.trim() && !html?.trim()) throw new EmailApiError(400, 'no_body', 'Give `text`, `html` or a `template`.');
  if (Buffer.byteLength(`${text ?? ''}${html ?? ''}`) > MAX_BODY_BYTES) throw new EmailApiError(400, 'too_large', 'The body is over 512 KiB.');

  const bare = all.map(bareAddress);
  const suppressedRows = await db.emailSuppression.findMany({ where: { orgId, address: { in: bare } }, select: { address: true } });
  const suppressed = new Set(suppressedRows.map((r) => r.address));
  const envelope = bare.filter((a) => !suppressed.has(a));
  const now = new Date().toISOString();
  const common = {
    orgId,
    credential: cred.smtpUsername,
    sender: bareAddress(input.from),
    domain: fromDomain,
    subject,
    source: input.source ?? ('api' as const),
  };
  if (!envelope.length) {
    recordEmailEvents(bare.map((rcpt) => emptyEvent({ ...common, ts: now, event: 'rejected', rcpt, detail: 'on the suppression list' })));
    throw new EmailApiError(422, 'all_suppressed', 'Every recipient is on the suppression list.', { suppressed: bare });
  }

  const built = buildMessage({ from: input.from, to, cc, replyTo: input.replyTo, subject, text, html, headers: input.headers, messageIdDomain: fromDomain });
  const mta = mtaEndpoint();
  let res;
  try {
    res = await smtpSubmit({ ...mta, username: cred.smtpUsername, password: smtpPasswordFor(cred.id), from: input.from, to: envelope, raw: built.raw });
  } catch (e) {
    if (e instanceof SmtpError && e.code >= 500) {
      throw new EmailApiError(422, 'refused', `The mail server refused the message: ${e.reply}`);
    }
    throw new EmailApiError(502, 'mta_unavailable', `The mail server could not take the message: ${e instanceof Error ? e.message : e}`);
  }
  rememberSent(built.messageId, { orgId, credentialId: cred.id });
  const rejected = res.rejected.map((r) => ({ address: r.rcpt.toLowerCase(), reason: r.reply }));
  const rejectedSet = new Set(rejected.map((r) => r.address));
  const accepted = envelope.filter((a) => !rejectedSet.has(a));
  recordEmailEvents([
    ...accepted.map((rcpt) =>
      emptyEvent({ ...common, ts: now, event: 'queued', rcpt, messageId: built.messageId, body: cfg.logBodies ? (text ?? html ?? '').slice(0, 64_000) : '' }),
    ),
    ...[...suppressed].map((rcpt) => emptyEvent({ ...common, ts: now, event: 'rejected', rcpt, messageId: built.messageId, detail: 'on the suppression list' })),
  ]);
  return { messageId: built.messageId, accepted, suppressed: [...suppressed], rejected, response: res.response };
}

/** The HTTP send API: authenticate the key, then {@link sendAsCredential}. */
export async function sendWithApiKey(db: DB, apiKey: string, input: SendInput): Promise<SendResult> {
  if (!apiKey) throw new EmailApiError(401, 'unauthorized', 'Send an `Authorization: Bearer sem_…` API key.');
  const cred = await db.emailCredential.findUnique({ where: { apiKeyHash: sha256(apiKey) } });
  if (!cred) throw new EmailApiError(401, 'unauthorized', 'Unknown API key.');
  return sendAsCredential(db, cred, { ...input, source: 'api' });
}

// ── reports ──────────────────────────────────────────────────────────────────

export interface IngestResult {
  kind: ParsedReport['kind'] | 'ignored';
  orgId: string | null;
  suppressed: string[];
  webhook: 'sent' | 'failed' | 'none';
}

async function orgForReport(db: DB, report: ParsedReport, hintOrgId?: string): Promise<{ orgId: string; credentialId: string | null } | null> {
  if (report.originalMessageId) {
    const hit = sentBy(`<${report.originalMessageId}>`) ?? sentBy(report.originalMessageId);
    if (hit) return hit;
  }
  const domain = addressDomain(report.originalSender ?? '');
  if (!domain && !hintOrgId) return null;
  const row = domain
    ? await db.emailDomain.findFirst({ where: { domain, ...(hintOrgId ? { orgId: hintOrgId } : {}) }, select: { orgId: true } })
    : null;
  const orgId = row?.orgId ?? hintOrgId ?? null;
  if (!orgId) return null;
  let credentialId: string | null = null;
  if (report.mtaMessageId) {
    const who = trackerFor(orgId).lookup(report.mtaMessageId);
    if (who?.username) {
      const cred = await db.emailCredential.findFirst({ where: { orgId, smtpUsername: who.username }, select: { id: true } });
      credentialId = cred?.id ?? null;
    }
  }
  return { orgId, credentialId };
}

/** Parse a report and act on it. `hintOrgId` scopes a report posted with an org's inbound token. */
export async function ingestReport(db: DB, raw: string, opts: { hintOrgId?: string; fetchImpl?: typeof fetch } = {}): Promise<IngestResult> {
  const report = parseReport(raw);
  if (!report) return { kind: 'ignored', orgId: null, suppressed: [], webhook: 'none' };
  const owner = await orgForReport(db, report, opts.hintOrgId);
  if (!owner) return { kind: report.kind, orgId: null, suppressed: [], webhook: 'none' };
  const { orgId, credentialId } = owner;
  const cred = credentialId ? await db.emailCredential.findFirst({ where: { id: credentialId, orgId } }) : null;

  const toSuppress = suppressionsFrom(report);
  for (const s of toSuppress) {
    await db.emailSuppression.upsert({
      where: { orgId_address: { orgId, address: s.address } },
      create: { orgId, address: s.address, reason: s.reason, detail: s.detail?.slice(0, 500) ?? null, credentialId },
      update: {},
    });
  }
  const now = new Date().toISOString();
  recordEmailEvents(
    report.recipients.map((r) =>
      emptyEvent({
        orgId,
        ts: now,
        event: report.kind === 'complaint' ? 'complained' : report.kind === 'bounce' && r.severity === 'hard' ? 'bounced' : 'deferred',
        mtaId: report.mtaMessageId ?? '',
        messageId: report.originalMessageId ? `<${report.originalMessageId}>` : '',
        credential: cred?.smtpUsername ?? '',
        sender: (report.originalSender ?? '').toLowerCase(),
        rcpt: r.address,
        domain: addressDomain(report.originalSender ?? '') ?? '',
        subject: report.originalSubject ?? '',
        smtpCode: Number(/\b([245]\d\d)\b/.exec(r.diagnostic ?? '')?.[1] ?? 0),
        detail: r.diagnostic ?? r.status ?? '',
        source: 'report',
      }),
    ),
  );

  let webhook: IngestResult['webhook'] = 'none';
  if (cred?.webhookUrl && (report.kind === 'bounce' || report.kind === 'complaint')) {
    webhook = (await postWebhook(cred, report, opts.fetchImpl ?? fetch)) ? 'sent' : 'failed';
  }
  return { kind: report.kind, orgId, suppressed: toSuppress.map((s) => s.address), webhook };
}

/** The bounce/complaint webhook body apps receive. */
export function webhookPayload(report: ParsedReport, credentialName: string) {
  return {
    type: report.kind === 'complaint' ? 'email.complained' : 'email.bounced',
    createdAt: new Date().toISOString(),
    data: {
      credential: credentialName,
      messageId: report.originalMessageId ? `<${report.originalMessageId}>` : null,
      from: report.originalSender,
      subject: report.originalSubject,
      feedbackType: report.feedbackType,
      recipients: report.recipients.map((r) => ({
        address: r.address,
        action: r.action,
        status: r.status,
        diagnostic: r.diagnostic,
        permanent: r.severity === 'hard',
      })),
    },
  };
}

async function postWebhook(cred: CredentialRow, report: ParsedReport, fetchImpl: typeof fetch): Promise<boolean> {
  let secret: string | null = null;
  try {
    secret = cred.webhookSecretEnc ? decryptSecret(cred.webhookSecretEnc) : null;
  } catch {
    secret = null;
  }
  const body = JSON.stringify(webhookPayload(report, cred.name));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(cred.webhookUrl!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'swarmy-email/1',
          ...(secret ? { 'x-swarmy-signature': signWebhook(secret, body) } : {}),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
      if (res.status < 500) return false;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return false;
}

/** Authenticate a POST /email/v1/inbound token → org id. */
export async function orgForInboundToken(db: DB, token: string): Promise<string | null> {
  if (!token) return null;
  const cfg = await db.emailConfig.findFirst({ where: { inboundTokenHash: sha256(token) }, select: { orgId: true } });
  return cfg?.orgId ?? null;
}

// ── swarmy's own mail ────────────────────────────────────────────────────────

export interface SystemMail {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  /** A saved email template (Email → Templates) rendered with `variables`. */
  template?: string;
  variables?: Record<string, unknown>;
  /** Prefer this org (else the first org with email on — one org per controller). */
  orgId?: string;
}

/**
 * Send one of swarmy's own emails through the org's email service. Returns
 * false (never throws) when the service is off or has no verified domain, so
 * callers fall back to their link-copy flows.
 */
export async function sendSystemEmail(db: DB, mail: SystemMail): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
  try {
    const cfg = await db.emailConfig.findFirst({
      where: { enabled: true, ...(mail.orgId ? { orgId: mail.orgId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    if (!cfg) return { sent: false, reason: 'email service off' };
    const cred = await db.emailCredential.findFirst({ where: { orgId: cfg.orgId, name: SYSTEM_CREDENTIAL } });
    if (!cred) return { sent: false, reason: 'no system credential' };
    const domains = await db.emailDomain.findMany({ where: { orgId: cfg.orgId, verifiedAt: { not: null } }, orderBy: { domain: 'asc' } });
    const d = domains.find((x) => x.id === cfg.systemDomainId) ?? domains[0];
    if (!d) return { sent: false, reason: 'no verified domain' };
    const res = await sendAsCredential(db, cred, {
      from: `swarmy <noreply@${d.domain}>`,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.template ? { template: mail.template, variables: mail.variables ?? {} } : {}),
      source: 'api',
    });
    return { sent: res.accepted.length > 0, messageId: res.messageId, ...(res.accepted.length ? {} : { reason: 'suppressed' }) };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Feed MTA log lines (the reconcile worker's log follower). */
export function ingestMtaLogLines(orgId: string, lines: string[]): EmailEvent[] {
  const t = trackerFor(orgId);
  const events = lines.flatMap((l) => t.feed(l));
  recordEmailEvents(events);
  return events;
}
