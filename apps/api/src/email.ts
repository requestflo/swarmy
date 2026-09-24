/**
 * Email service, controller data plane (epic developer-platform §8):
 *
 *   POST /email/v1/send     the HTTP send API — `Authorization: Bearer sem_…`
 *                           (the app's EMAIL_API_KEY); JSON body, see SendBody
 *   POST /email/v1/inbound  forwarded bounce/complaint reports (raw RFC 5322
 *                           DSN/ARF) — `Authorization: Bearer semin_…`
 *   :2525 (SMTP)            the bounce hook the MTA delivers its DSNs to, on
 *                           the control overlay, AUTH with a derived token
 *
 * plus swarmy's own mail: Better Auth's verification / magic-link / reset
 * mail goes through the email service when it is on (`mountEmail`).
 * All logic lives in @swarmy/trpc (email/runtime.ts); this file is transport.
 */
import { Hono } from 'hono';
import { authRegistry } from '@swarmy/auth';
import { prisma } from '@swarmy/db';
import {
  BOUNCE_HOOK_PORT,
  BOUNCE_HOOK_USER,
  bounceHookPassword,
  EmailApiError,
  emailSafeEqual,
  ingestReport,
  orgForInboundToken,
  sendSystemEmail,
  sendWithApiKey,
  startSmtpSink,
} from '@swarmy/trpc';

const SEND_KEYS = new Set(['from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'text', 'html', 'template', 'variables', 'headers']);

type ParsedSend =
  | { ok: true; value: { from: string; to: string[]; cc?: string[]; bcc?: string[]; replyTo?: string; subject?: string; text?: string; html?: string; template?: string; variables?: Record<string, unknown>; headers?: Record<string, string> } }
  | { ok: false; issues: string[] };

/** Validate a send body (no zod in this app; the service re-validates addresses). */
export function parseSendBody(body: unknown): ParsedSend {
  const issues: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, issues: ['the body must be a JSON object'] };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!SEND_KEYS.has(k)) issues.push(`unknown field "${k}"`);
  const str = (k: string, max: number, required = false): string | undefined => {
    const v = b[k];
    if (v === undefined || v === null) {
      if (required) issues.push(`"${k}" is required`);
      return undefined;
    }
    if (typeof v !== 'string' || v.length > max) {
      issues.push(`"${k}" must be a string of at most ${max} characters`);
      return undefined;
    }
    return v;
  };
  const addrs = (k: string, required = false): string[] | undefined => {
    const v = b[k];
    if (v === undefined || v === null) {
      if (required) issues.push(`"${k}" is required`);
      return undefined;
    }
    const arr = Array.isArray(v) ? v : [v];
    if (arr.length > 50 || !arr.every((a) => typeof a === 'string' && a.length <= 320)) {
      issues.push(`"${k}" must be an address or a list of at most 50`);
      return undefined;
    }
    return arr as string[];
  };
  const obj = (k: string): Record<string, unknown> | undefined => {
    const v = b[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) {
      issues.push(`"${k}" must be an object`);
      return undefined;
    }
    return v as Record<string, unknown>;
  };
  const headers = obj('headers');
  if (headers && !Object.values(headers).every((v) => typeof v === 'string' && v.length <= 998)) issues.push('"headers" values must be strings');
  const value = {
    from: str('from', 320, true) ?? '',
    to: addrs('to', true) ?? [],
    cc: addrs('cc'),
    bcc: addrs('bcc'),
    replyTo: str('replyTo', 320),
    subject: str('subject', 998),
    text: str('text', 512 * 1024),
    html: str('html', 512 * 1024),
    template: str('template', 64),
    variables: obj('variables'),
    headers: headers as Record<string, string> | undefined,
  };
  return issues.length ? { ok: false, issues } : { ok: true, value };
}

function bearer(h: string | undefined): string {
  const m = /^Bearer\s+(\S+)$/i.exec(h ?? '');
  return m ? m[1]! : '';
}

export const emailApp = new Hono();

emailApp.post('/v1/send', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'invalid_json', message: 'The body must be JSON.' } }, 400);
  }
  const parsed = parseSendBody(body);
  if (!parsed.ok) return c.json({ error: { code: 'invalid_request', message: 'Invalid send request.', issues: parsed.issues } }, 400);
  try {
    const res = await sendWithApiKey(prisma, bearer(c.req.header('authorization')), parsed.value);
    return c.json({ id: res.messageId, accepted: res.accepted, suppressed: res.suppressed, rejected: res.rejected }, 202);
  } catch (e) {
    if (e instanceof EmailApiError) return c.json({ error: { code: e.code, message: e.message, ...(e.details ?? {}) } }, e.status);
    return c.json({ error: { code: 'internal', message: 'The message could not be sent.' } }, 500);
  }
});

emailApp.post('/v1/inbound', async (c) => {
  const orgId = await orgForInboundToken(prisma, bearer(c.req.header('authorization')));
  if (!orgId) return c.json({ error: { code: 'unauthorized', message: 'Unknown inbound token.' } }, 401);
  const raw = await c.req.text();
  if (raw.length > 4 * 1024 * 1024) return c.json({ error: { code: 'too_large', message: 'Reports are limited to 4 MiB.' } }, 413);
  const r = await ingestReport(prisma, raw, { hintOrgId: orgId });
  return c.json({ kind: r.kind, suppressed: r.suppressed, webhook: r.webhook }, r.kind === 'ignored' ? 422 : 200);
});

/**
 * Start the bounce hook and route Better Auth's mail through the email
 * service. Call before `authRegistry.rebuild()`. Never throws: without a vault
 * key or a free port the hook stays off and auth mail keeps its log fallback.
 */
export async function mountEmail(): Promise<void> {
  authRegistry.configure({
    sendEmail: async (mail) => {
      const r = await sendSystemEmail(prisma, mail);
      if (!r.sent) {
        // eslint-disable-next-line no-console
        console.info(`[email] not sent to ${mail.to} (${r.reason}); ${mail.subject}: ${mail.text.split('\n').find((l) => l.includes('http')) ?? ''}`);
      }
      return r.sent;
    },
  });
  if (!process.env.SWARMY_SECRET_KEY || process.env.SWARMY_EMAIL_BOUNCE_HOOK === '0') return;
  const port = Number(process.env.SWARMY_EMAIL_BOUNCE_PORT) || BOUNCE_HOOK_PORT;
  try {
    const expected = bounceHookPassword();
    await startSmtpSink({
      port,
      hostname: 'swarmy-controller',
      auth: (u, p) => u === BOUNCE_HOOK_USER && emailSafeEqual(p, expected),
      onMessage: async (m) => {
        await ingestReport(prisma, m.raw);
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[email] bounce hook not listening on :${port}: ${e instanceof Error ? e.message : e}`);
  }
}
