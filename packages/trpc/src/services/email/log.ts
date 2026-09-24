/**
 * The send log: one row per recipient event, metadata only (bodies only when
 * the org turns `logBodies` on). Stored in the org's ClickHouse store (the
 * observability suite's), next to its telemetry; while that store is off the
 * controller keeps the most recent events in memory and says so.
 *
 * Events come from two places:
 *   - the MTA's own structured log (maddy writes `<message>\t{json}` lines),
 *     followed through the agent's log stream — this covers mail submitted
 *     over SMTP by apps AND the HTTP API (which submits through the MTA too);
 *   - the controller itself: `api` rows at send time (subject, Message-ID,
 *     template) and `bounced` / `complained` rows from parsed reports.
 * Pure: the line parser, the per-message tracker and the SQL builders.
 */

export type EmailEventKind =
  | 'queued' // controller accepted an API send
  | 'accepted' // MTA accepted the recipient
  | 'rejected' // MTA refused at submission (suppressed, unauthorized sender, …)
  | 'delivered'
  | 'deferred' // a delivery attempt failed, will retry
  | 'failed' // permanent failure (a DSN follows)
  | 'bounced' // parsed DSN (hard)
  | 'complained'; // parsed ARF report

export interface EmailEvent {
  ts: string; // ISO
  orgId: string;
  event: EmailEventKind;
  /** The MTA queue id (maddy msg_id), when known. */
  mtaId: string;
  /** RFC 5322 Message-ID, when known. */
  messageId: string;
  /** SMTP username of the credential (`<name>@swarmy`). */
  credential: string;
  sender: string;
  rcpt: string;
  /** Sender domain. */
  domain: string;
  subject: string;
  smtpCode: number;
  detail: string;
  source: 'api' | 'smtp' | 'report';
  /** Only with logBodies. */
  body: string;
}

export function emptyEvent(partial: Partial<EmailEvent> & Pick<EmailEvent, 'orgId' | 'event'>): EmailEvent {
  return {
    ts: new Date().toISOString(),
    mtaId: '',
    messageId: '',
    credential: '',
    sender: '',
    rcpt: '',
    domain: '',
    subject: '',
    smtpCode: 0,
    detail: '',
    source: 'smtp',
    body: '',
    ...partial,
  };
}

// ── maddy log lines ──────────────────────────────────────────────────────────

export interface MaddyLine {
  message: string;
  fields: Record<string, unknown>;
}

/**
 * Parse one maddy log line. Tolerates the `docker service logs` prefix
 * (`swarmy-mail.1.abc@node    | `) and a leading timestamp.
 */
export function parseMaddyLine(line: string): MaddyLine | null {
  const brace = line.indexOf('{');
  if (brace < 0) return null;
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(line.slice(brace).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  let head = line.slice(0, brace);
  const bar = head.lastIndexOf('| ');
  if (bar >= 0) head = head.slice(bar + 2);
  head = head.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '').trim();
  return { message: head, fields };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

interface Pending {
  sender: string;
  username: string;
  rcpts: string[];
  at: number;
}

/**
 * Turns the MTA's line stream into send-log events. Keeps a bounded map of
 * in-flight messages (msg_id → sender/username) so delivery lines, which only
 * carry msg_id + rcpt, are attributed to a credential.
 */
export class MaddyLogTracker {
  private pending = new Map<string, Pending>();
  private known = new Map<string, { sender: string; username: string }>();

  constructor(
    private readonly orgId: string,
    private readonly limit = 50_000,
  ) {}

  /** The credential/sender of an MTA message id (bounce attribution). */
  lookup(mtaId: string): { sender: string; username: string } | undefined {
    return this.known.get(mtaId);
  }

  private remember(id: string, v: { sender: string; username: string }): void {
    this.known.set(id, v);
    if (this.known.size > this.limit) this.known.delete(this.known.keys().next().value as string);
  }

  feed(line: string, now = new Date()): EmailEvent[] {
    const p = parseMaddyLine(line);
    if (!p) return [];
    const f = p.fields;
    const id = str(f.msg_id);
    if (!id) return [];
    const msg = p.message.toLowerCase();
    const ts = now.toISOString();
    const who = this.known.get(id) ?? { sender: '', username: '' };
    const ev = (event: EmailEventKind, extra: Partial<EmailEvent>): EmailEvent =>
      emptyEvent({
        orgId: this.orgId,
        event,
        ts,
        mtaId: id,
        credential: who.username,
        sender: who.sender,
        domain: domainOf(who.sender),
        source: 'smtp',
        ...extra,
      });

    if (msg.endsWith('incoming message')) {
      const v = { sender: str(f.sender).toLowerCase(), username: str(f.username) };
      this.pending.set(id, { ...v, rcpts: [], at: now.getTime() });
      this.remember(id, v);
      if (this.pending.size > 5000) this.pending.delete(this.pending.keys().next().value as string);
      return [];
    }
    if (msg.endsWith('rcpt ok')) {
      this.pending.get(id)?.rcpts.push(str(f.rcpt).toLowerCase());
      return [];
    }
    if (msg.endsWith('accepted')) {
      const pend = this.pending.get(id);
      this.pending.delete(id);
      return (pend?.rcpts ?? []).map((rcpt) => ev('accepted', { rcpt }));
    }
    if (msg.includes('rcpt error') || msg.includes('mail from error')) {
      return [
        ev('rejected', {
          rcpt: str(f.rcpt || f.effective_rcpt).toLowerCase(),
          smtpCode: Number(f.smtp_code) || 0,
          detail: str(f.smtp_msg || f.reason),
        }),
      ];
    }
    if (msg === 'delivered') return [ev('delivered', { rcpt: str(f.rcpt).toLowerCase() })];
    if (msg.startsWith('delivery attempt failed')) {
      return [ev('deferred', { rcpt: str(f.rcpt).toLowerCase(), smtpCode: Number(f.smtp_code) || 0, detail: str(f.smtp_msg || f.reason) })];
    }
    if (msg.startsWith('not delivered')) {
      return [ev('failed', { rcpt: str(f.rcpt).toLowerCase(), detail: str(f.reason) || 'permanent error' })];
    }
    return [];
  }
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).toLowerCase() : '';
}

// ── ClickHouse ───────────────────────────────────────────────────────────────

export const EMAIL_LOG_TABLE = 'swarmy_email_log';

/** DDL — idempotent; created by the controller on first write (the collector owns only the otel_* tables). */
export function emailLogDdl(database: string, retentionDays: number): string {
  return `CREATE TABLE IF NOT EXISTS ${database}.${EMAIL_LOG_TABLE} (
  ts DateTime64(3, 'UTC'),
  org_id LowCardinality(String),
  event LowCardinality(String),
  mta_id String,
  message_id String,
  credential LowCardinality(String),
  sender String,
  rcpt String,
  domain LowCardinality(String),
  subject String,
  smtp_code UInt16,
  detail String,
  source LowCardinality(String),
  body String
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (org_id, ts)
TTL toDateTime(ts) + INTERVAL ${Math.max(1, Math.floor(retentionDays))} DAY`;
}

/** JSONEachRow body for an INSERT. */
export function emailLogRows(events: EmailEvent[]): string {
  return events
    .map((e) =>
      JSON.stringify({
        ts: e.ts.replace('T', ' ').replace('Z', ''),
        org_id: e.orgId,
        event: e.event,
        mta_id: e.mtaId,
        message_id: e.messageId,
        credential: e.credential,
        sender: e.sender,
        rcpt: e.rcpt,
        domain: e.domain,
        subject: e.subject,
        smtp_code: e.smtpCode,
        detail: e.detail.slice(0, 1000),
        source: e.source,
        body: e.body,
      }),
    )
    .join('\n');
}

function lit(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface EmailLogQuery {
  /** Free-text match on rcpt/sender/subject/message id. */
  search?: string;
  event?: EmailEventKind;
  credential?: string;
  /** ISO lower bound (exclusive cursor: rows strictly older than `before`). */
  before?: string;
  limit?: number;
}

/** Newest-first page for one org (org filter is structural, never optional). */
export function emailLogSelect(database: string, orgId: string, q: EmailLogQuery): string {
  const where = [`org_id = ${lit(orgId)}`];
  if (q.event) where.push(`event = ${lit(q.event)}`);
  if (q.credential) where.push(`credential = ${lit(q.credential)}`);
  if (q.before) where.push(`ts < parseDateTime64BestEffort(${lit(q.before)}, 3)`);
  if (q.search) {
    const s = q.search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const like = lit(`%${s}%`);
    where.push(`(rcpt ILIKE ${like} OR sender ILIKE ${like} OR subject ILIKE ${like} OR message_id ILIKE ${like} OR mta_id ILIKE ${like})`);
  }
  const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 100)));
  return `SELECT formatDateTime(ts, '%Y-%m-%dT%H:%i:%S.%fZ') AS ts, event, mta_id, message_id, credential, sender, rcpt, domain, subject, smtp_code, detail, source FROM ${database}.${EMAIL_LOG_TABLE} WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
}

/** Filter the in-memory fallback ring the same way. */
export function filterEvents(events: readonly EmailEvent[], q: EmailLogQuery): EmailEvent[] {
  const s = q.search?.toLowerCase();
  const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 100)));
  return events
    .filter(
      (e) =>
        (!q.event || e.event === q.event) &&
        (!q.credential || e.credential === q.credential) &&
        (!q.before || e.ts < q.before) &&
        (!s || [e.rcpt, e.sender, e.subject, e.messageId, e.mtaId].some((v) => v.toLowerCase().includes(s))),
    )
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, limit);
}
