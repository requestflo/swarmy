/**
 * Bounce and complaint parsing: RFC 3464 delivery status notifications
 * (multipart/report; report-type=delivery-status) and RFC 5965 ARF feedback
 * reports (report-type=feedback-report). Pure.
 *
 * Sources: the MTA hands every DSN it generates (a relay or a remote MX
 * refused the message) to the controller's bounce hook; asynchronous bounces
 * and feedback-loop complaints can be forwarded to POST /email/v1/inbound.
 *
 * Classification (what the suppression list does with it):
 *   hard  — permanent failure (5.x.x) on the recipient → suppress
 *   soft  — transient (4.x.x) or a delayed notice → log only
 *   complaint — the recipient reported the mail as spam → suppress
 */
import { decodeWords, findPart, parseHeaderBlock, parseMime, type MimePart } from './mime';

export type ReportKind = 'bounce' | 'delay' | 'complaint';

export interface ReportRecipient {
  address: string;
  /** failed | delayed | delivered | relayed | expanded (DSN), or 'complaint'. */
  action: string;
  /** Enhanced status code, e.g. 5.1.1. */
  status: string | null;
  /** Remote diagnostic, e.g. `smtp; 550 5.1.1 user unknown`. */
  diagnostic: string | null;
  /** hard = suppress; soft = log only. */
  severity: 'hard' | 'soft';
}

export interface ParsedReport {
  kind: ReportKind;
  recipients: ReportRecipient[];
  /** The original message's Message-ID, when the report carries its headers. */
  originalMessageId: string | null;
  /** The original envelope sender / From. */
  originalSender: string | null;
  originalSubject: string | null;
  /** The MTA's own queue id (maddy: X-Maddy-Msgid) — joins the send log. */
  mtaMessageId: string | null;
  /** ARF Feedback-Type (abuse, fraud, …). */
  feedbackType: string | null;
  reportingMta: string | null;
}

const stripType = (v: string | undefined): string | null => {
  if (!v) return null;
  const semi = v.indexOf(';');
  return (semi >= 0 ? v.slice(semi + 1) : v).trim() || null;
};

const angle = (v: string | undefined): string | null => {
  if (!v) return null;
  const m = /<([^>]+)>/.exec(v);
  return (m ? m[1]! : v).trim() || null;
};

/** Split a message/delivery-status body into its field groups (per-message, then per-recipient). */
function statusGroups(body: string): ReturnType<typeof parseHeaderBlock>[] {
  return body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .filter((b) => /\S/.test(b))
    .map((b) => parseHeaderBlock(b));
}

function originalHeaders(root: MimePart): ReturnType<typeof parseHeaderBlock> | null {
  // RFC 6522 names it text/rfc822-headers; maddy writes message/rfc822-headers.
  const headersPart = findPart(root, 'text/rfc822-headers') ?? findPart(root, 'message/rfc822-headers');
  if (headersPart) return parseHeaderBlock(headersPart.body);
  const msg = findPart(root, 'message/rfc822');
  if (msg) {
    // A message/rfc822 part: either parsed as a leaf (body = the whole inner
    // message) or, rarely, split further.
    const inner = msg.body || '';
    const cut = /\r?\n\r?\n/.exec(inner);
    return parseHeaderBlock(cut ? inner.slice(0, cut.index) : inner);
  }
  return null;
}

function severityOf(action: string, status: string | null): 'hard' | 'soft' {
  if (action === 'failed') return status?.startsWith('4') ? 'soft' : 'hard';
  return 'soft';
}

/** Parse a raw report message; null when it is neither a DSN nor an ARF report. */
export function parseReport(raw: string): ParsedReport | null {
  const root = parseMime(raw);
  const orig = originalHeaders(root);
  const base = {
    originalMessageId: angle(orig?.get('message-id')),
    originalSender: angle(orig?.get('from')),
    originalSubject: orig?.get('subject') ? decodeWords(orig.get('subject')!) : null,
  };

  const arf = findPart(root, 'message/feedback-report');
  if (arf) {
    const f = parseHeaderBlock(arf.body);
    const rcpts = (f.all.get('original-rcpt-to') ?? []).map((a) => angle(a)).filter((a): a is string => !!a);
    const toFromOrig = angle(orig?.get('to'));
    const addresses = rcpts.length ? rcpts : toFromOrig ? [toFromOrig] : [];
    return {
      kind: 'complaint',
      recipients: addresses.map((address) => ({
        address: address.toLowerCase(),
        action: 'complaint',
        status: null,
        diagnostic: f.get('feedback-type') ?? null,
        severity: 'hard',
      })),
      ...base,
      originalSender: angle(f.get('original-mail-from')) ?? base.originalSender,
      mtaMessageId: null,
      feedbackType: (f.get('feedback-type') ?? 'abuse').toLowerCase(),
      reportingMta: stripType(f.get('reporting-mta')),
    };
  }

  const ds = findPart(root, 'message/delivery-status');
  if (!ds) return null;
  const [perMessage, ...perRecipient] = statusGroups(ds.body);
  const recipients: ReportRecipient[] = [];
  for (const g of perRecipient.length ? perRecipient : perMessage ? [perMessage] : []) {
    const address = stripType(g.get('final-recipient')) ?? stripType(g.get('original-recipient'));
    if (!address) continue;
    const action = (g.get('action') ?? '').trim().toLowerCase();
    const status = g.get('status')?.trim() ?? null;
    recipients.push({
      address: address.replace(/^<|>$/g, '').toLowerCase(),
      action,
      status,
      diagnostic: g.get('diagnostic-code') ?? null,
      severity: severityOf(action, status),
    });
  }
  const failed = recipients.some((r) => r.action === 'failed');
  return {
    kind: failed ? 'bounce' : 'delay',
    recipients,
    ...base,
    originalSender: base.originalSender ?? stripType(perMessage?.get('x-maddy-sender')),
    mtaMessageId: perMessage?.get('x-maddy-msgid')?.trim() ?? null,
    feedbackType: null,
    reportingMta: stripType(perMessage?.get('reporting-mta')),
  };
}

/** Addresses a report should add to the suppression list. */
export function suppressionsFrom(report: ParsedReport): Array<{ address: string; reason: 'bounce' | 'complaint'; detail: string | null }> {
  return report.recipients
    .filter((r) => r.severity === 'hard')
    .map((r) => ({
      address: r.address,
      reason: report.kind === 'complaint' ? 'complaint' : 'bounce',
      detail: r.diagnostic ?? r.status,
    }));
}
