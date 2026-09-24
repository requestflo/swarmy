import { describe, expect, it } from 'bun:test';
import { emailLogDdl, emailLogRows, emailLogSelect, emptyEvent, filterEvents, MaddyLogTracker, parseMaddyLine } from './log';

// Real maddy 0.9.5 lines (tab between message and JSON), with and without the
// `docker service logs` prefix.
const LINES = [
  'swarmy-mail.1.abc@node1    | submission: incoming message\t{"msg_id":"161c8b61","sender":"noreply@example.test","src_host":"h","src_ip":"10.0.0.5:20725","username":"web.abc123@swarmy"}',
  'submission: RCPT ok\t{"msg_id":"161c8b61","rcpt":"someone@dest.test"}',
  'submission: RCPT ok\t{"msg_id":"161c8b61","rcpt":"other@dest.test"}',
  'submission: accepted\t{"msg_id":"161c8b61"}',
  'delivered\t{"attempt":1,"msg_id":"161c8b61","rcpt":"someone@dest.test"}',
  'delivery attempt failed\t{"msg_id":"161c8b61","rcpt":"other@dest.test","reason":"try later","smtp_code":451,"smtp_msg":"greylisted"}',
  'not delivered, permanent error\t{"msg_id":"161c8b61","rcpt":"other@dest.test"}',
  'submission: RCPT error\t{"effective_rcpt":"gone@dest.test","msg_id":"ee12c63d","rcpt":"gone@dest.test","reason":"reject directive used","smtp_code":550,"smtp_enchcode":"5.1.1","smtp_msg":"recipient is on the suppression list"}',
  'server started\t{"version":"0.9.5"}',
  'garbage line',
];

describe('parseMaddyLine', () => {
  it('splits message and fields, dropping the docker prefix', () => {
    expect(parseMaddyLine(LINES[0]!)).toMatchObject({ message: 'submission: incoming message', fields: { msg_id: '161c8b61' } });
    expect(parseMaddyLine('garbage line')).toBeNull();
  });
});

describe('MaddyLogTracker', () => {
  it('turns the line stream into per-recipient events attributed to the credential', () => {
    const t = new MaddyLogTracker('org1');
    const events = LINES.flatMap((l) => t.feed(l, new Date('2026-09-24T18:00:00Z')));
    expect(events.map((e) => [e.event, e.rcpt, e.credential, e.smtpCode])).toEqual([
      ['accepted', 'someone@dest.test', 'web.abc123@swarmy', 0],
      ['accepted', 'other@dest.test', 'web.abc123@swarmy', 0],
      ['delivered', 'someone@dest.test', 'web.abc123@swarmy', 0],
      ['deferred', 'other@dest.test', 'web.abc123@swarmy', 451],
      ['failed', 'other@dest.test', 'web.abc123@swarmy', 0],
      ['rejected', 'gone@dest.test', '', 550],
    ]);
    expect(events[0]).toMatchObject({ orgId: 'org1', sender: 'noreply@example.test', domain: 'example.test', mtaId: '161c8b61', source: 'smtp' });
    expect(t.lookup('161c8b61')).toEqual({ sender: 'noreply@example.test', username: 'web.abc123@swarmy' });
  });
});

describe('ClickHouse send log SQL', () => {
  it('DDL is idempotent with a TTL', () => {
    const ddl = emailLogDdl('otel', 7);
    expect(ddl).toStartWith('CREATE TABLE IF NOT EXISTS otel.swarmy_email_log');
    expect(ddl).toContain('INTERVAL 7 DAY');
  });
  it('every query is org-scoped and escapes user input', () => {
    const sql = emailLogSelect('otel', "o'1", { search: "x'%_", event: 'bounced', limit: 9999 });
    expect(sql).toContain("org_id = 'o\\'1'");
    expect(sql).toContain("event = 'bounced'");
    expect(sql).toContain(String.raw`'%x\'\\%\\_%'`);
    expect(sql).toContain('LIMIT 500');
  });
  it('rows are JSONEachRow with ClickHouse timestamps', () => {
    const row = JSON.parse(emailLogRows([emptyEvent({ orgId: 'o', event: 'queued', ts: '2026-09-24T18:00:00.123Z', rcpt: 'a@b.c' })]));
    expect(row).toMatchObject({ ts: '2026-09-24 18:00:00.123', org_id: 'o', event: 'queued', rcpt: 'a@b.c', body: '' });
  });
  it('the in-memory fallback filters like the query', () => {
    const evs = [
      emptyEvent({ orgId: 'o', event: 'queued', ts: '2026-09-24T18:00:01Z', rcpt: 'a@b.c' }),
      emptyEvent({ orgId: 'o', event: 'bounced', ts: '2026-09-24T18:00:02Z', rcpt: 'x@y.z' }),
    ];
    expect(filterEvents(evs, {}).map((e) => e.event)).toEqual(['bounced', 'queued']);
    expect(filterEvents(evs, { search: 'Y.Z' }).map((e) => e.rcpt)).toEqual(['x@y.z']);
    expect(filterEvents(evs, { before: '2026-09-24T18:00:02Z' }).map((e) => e.event)).toEqual(['queued']);
  });
});
