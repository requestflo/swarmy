/**
 * Send-log storage + the email service's process memory.
 *
 * Send log: ClickHouse (the org's observability store) when it is on — rows
 * are buffered and flushed in batches; the table is created on first use.
 * Always also a bounded in-memory ring per org, which is what the Email page
 * reads while the store is off (and says so).
 *
 * Process memory (never persisted — re-derived after a restart): DNS check
 * results per domain, the port-25 probe, the MTA log tracker per org, and the
 * Message-ID → credential index for bounce attribution of API sends.
 */
import type { ProbeSmtpResult } from '@swarmy/core/protocol';
import type { EmailDomainCheck } from './dns';
import {
  EMAIL_LOG_TABLE,
  emailLogDdl,
  emailLogRows,
  emailLogSelect,
  filterEvents,
  MaddyLogTracker,
  type EmailEvent,
  type EmailLogQuery,
} from './log';

const RING_MAX = 2000;
const FLUSH_MS = 5_000;
const FLUSH_BATCH = 500;

export interface StoreRef {
  dsn: string;
  retentionDays: number;
}

interface ChDsn {
  baseUrl: string;
  user: string;
  password: string;
  database: string;
}

function parseDsn(dsn: string): ChDsn {
  const u = new URL(dsn);
  return {
    baseUrl: `${u.protocol}//${u.host}`,
    user: decodeURIComponent(u.username || 'default'),
    password: decodeURIComponent(u.password || ''),
    database: u.pathname.replace(/^\//, '') || 'otel',
  };
}

async function ch(dsn: ChDsn, sql: string, body?: string, json = false): Promise<string> {
  const url = new URL(dsn.baseUrl);
  url.searchParams.set('database', dsn.database);
  if (json) url.searchParams.set('default_format', 'JSONEachRow');
  if (body !== undefined) url.searchParams.set('query', sql);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'X-ClickHouse-User': dsn.user, 'X-ClickHouse-Key': dsn.password, 'Content-Type': 'text/plain' },
    body: body ?? sql,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

class OrgLog {
  ring: EmailEvent[] = [];
  buffer: EmailEvent[] = [];
  tableReady = false;
  lastError: string | null = null;
}

const logs = new Map<string, OrgLog>();
const stores = new Map<string, StoreRef | null>();
let timer: ReturnType<typeof setInterval> | null = null;

function orgLog(orgId: string): OrgLog {
  let l = logs.get(orgId);
  if (!l) {
    l = new OrgLog();
    logs.set(orgId, l);
  }
  return l;
}

/** Tell the store where an org's ClickHouse is (null = off). Set by the reconcile worker and the service. */
export function setEmailLogStore(orgId: string, store: StoreRef | null): void {
  const prev = stores.get(orgId);
  if (prev?.dsn !== store?.dsn) orgLog(orgId).tableReady = false;
  stores.set(orgId, store);
}

export function emailLogStoreOf(orgId: string): StoreRef | null {
  return stores.get(orgId) ?? null;
}

/** Record events (ring now, ClickHouse on the next flush). */
export function recordEmailEvents(events: EmailEvent[]): void {
  for (const e of events) {
    const l = orgLog(e.orgId);
    l.ring.push(e);
    if (l.ring.length > RING_MAX) l.ring.splice(0, l.ring.length - RING_MAX);
    if (stores.get(e.orgId)) l.buffer.push(e);
  }
  if (!timer) {
    timer = setInterval(() => void flushEmailLogs(), FLUSH_MS);
    (timer as { unref?: () => void }).unref?.();
  }
}

export async function flushEmailLogs(): Promise<void> {
  for (const [orgId, l] of logs) {
    const store = stores.get(orgId);
    if (!store || l.buffer.length === 0) continue;
    const batch = l.buffer.splice(0, FLUSH_BATCH);
    try {
      const dsn = parseDsn(store.dsn);
      if (!l.tableReady) {
        await ch(dsn, emailLogDdl(dsn.database, store.retentionDays));
        l.tableReady = true;
      }
      await ch(dsn, `INSERT INTO ${dsn.database}.${EMAIL_LOG_TABLE} FORMAT JSONEachRow`, emailLogRows(batch));
      l.lastError = null;
    } catch (e) {
      l.lastError = e instanceof Error ? e.message : String(e);
      // Keep the batch for the next tick, bounded (the ring still has it).
      l.buffer.unshift(...batch);
      if (l.buffer.length > RING_MAX * 5) l.buffer.splice(0, l.buffer.length - RING_MAX * 5);
    }
  }
}

export interface EmailLogPage {
  items: Array<Omit<EmailEvent, 'orgId' | 'body'>>;
  /** 'clickhouse' = durable; 'memory' = the last events this controller saw. */
  source: 'clickhouse' | 'memory';
  storeError: string | null;
}

export async function readEmailLog(orgId: string, q: EmailLogQuery): Promise<EmailLogPage> {
  const store = stores.get(orgId);
  const l = orgLog(orgId);
  const strip = (e: EmailEvent) => {
    const { orgId: _o, body: _b, ...rest } = e;
    return rest;
  };
  if (store) {
    try {
      const dsn = parseDsn(store.dsn);
      const text = await ch(dsn, emailLogSelect(dsn.database, orgId, q), undefined, true);
      const rows = text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, string | number>);
      return {
        source: 'clickhouse',
        storeError: null,
        items: rows.map((r) => ({
          ts: String(r.ts),
          event: String(r.event) as EmailEvent['event'],
          mtaId: String(r.mta_id ?? ''),
          messageId: String(r.message_id ?? ''),
          credential: String(r.credential ?? ''),
          sender: String(r.sender ?? ''),
          rcpt: String(r.rcpt ?? ''),
          domain: String(r.domain ?? ''),
          subject: String(r.subject ?? ''),
          smtpCode: Number(r.smtp_code ?? 0),
          detail: String(r.detail ?? ''),
          source: String(r.source ?? 'smtp') as EmailEvent['source'],
        })),
      };
    } catch (e) {
      // Table not there yet (no mail since the store came up) or store down.
      return { source: 'memory', storeError: e instanceof Error ? e.message : String(e), items: filterEvents(l.ring, q).map(strip) };
    }
  }
  return { source: 'memory', storeError: null, items: filterEvents(l.ring, q).map(strip) };
}

// ── process memory ───────────────────────────────────────────────────────────

const trackers = new Map<string, MaddyLogTracker>();
export function trackerFor(orgId: string): MaddyLogTracker {
  let t = trackers.get(orgId);
  if (!t) {
    t = new MaddyLogTracker(orgId);
    trackers.set(orgId, t);
  }
  return t;
}

const sentIndex = new Map<string, { orgId: string; credentialId: string }>();
export function rememberSent(messageId: string, v: { orgId: string; credentialId: string }): void {
  sentIndex.set(messageId, v);
  if (sentIndex.size > 50_000) sentIndex.delete(sentIndex.keys().next().value as string);
}
export function sentBy(messageId: string): { orgId: string; credentialId: string } | undefined {
  return sentIndex.get(messageId);
}

const checks = new Map<string, EmailDomainCheck>();
export function setDomainCheck(domainId: string, c: EmailDomainCheck): void {
  checks.set(domainId, c);
}
export function domainCheck(domainId: string): EmailDomainCheck | undefined {
  return checks.get(domainId);
}

export interface Port25Probe {
  result: ProbeSmtpResult;
  verdict: 'open' | 'blocked' | 'unknown';
  message: string;
  nodeId: string;
  at: number;
}
const probes = new Map<string, Port25Probe>();
export function setPort25Probe(orgId: string, p: Port25Probe): void {
  probes.set(orgId, p);
}
export function port25Probe(orgId: string): Port25Probe | undefined {
  return probes.get(orgId);
}

/** Tests only. */
export function resetEmailMemory(): void {
  logs.clear();
  stores.clear();
  trackers.clear();
  sentIndex.clear();
  checks.clear();
  probes.clear();
}
