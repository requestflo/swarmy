import { describe, expect, it } from 'bun:test';
import { AlertEventDto, IncidentDetailDto, IncidentList } from '../dto-incidents';
import { alertEventToDto, incidentToDto } from '../mappers-incidents';
import { testApp, type TestAppOptions } from '../test-kit';
import { memTable } from '../test-mem';

/**
 * /incidents and /alert-events ride incidents.service / alerts.service: reads
 * `read`, resolve / acknowledge `write` (any member), audited by the service.
 */

const opened = new Date('2026-10-01T00:00:00.000Z');

function setup(scopes: TestAppOptions['scopes'] = ['write']) {
  const events = memTable('ie', [
    { id: 'ie1', orgId: 'org1', incidentId: 'inc1', at: opened, kind: 'opened', message: 'Shop is down', meta: { groupKey: 'alert:shop' } },
  ]);
  const incidents = [
    { id: 'inc1', orgId: 'org1', title: 'Shop is down', status: 'OPEN', severity: 'critical', summary: null, openedAt: opened, resolvedAt: null },
    { id: 'inc2', orgId: 'org2', title: 'Other org', status: 'OPEN', severity: 'minor', summary: null, openedAt: opened, resolvedAt: null },
  ];
  const withEvents = (r: (typeof incidents)[number]) => {
    const evs = events.rows.filter((e) => e.incidentId === r.id);
    return { ...r, events: evs, _count: { events: evs.length } };
  };
  const incident = {
    findMany: async ({ where }: { where: { orgId: string; status?: string } }) =>
      incidents.filter((r) => r.orgId === where.orgId && (!where.status || r.status === where.status)).map(withEvents),
    findFirst: async ({ where }: { where: { id: string; orgId: string } }) => {
      const r = incidents.find((x) => x.id === where.id && x.orgId === where.orgId);
      return r ? withEvents(r) : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Object.assign(incidents.find((x) => x.id === where.id)!, data),
  };
  const alerts = memTable('ae', [
    { id: 'ae1', orgId: 'org1', ruleId: 'ar1', rule: { name: 'Shop down' }, signal: 'service-down', severity: 'critical',
      resource: 'shop', message: 'shop_web has no running copies', status: 'FIRING', notify: 'SENT', firedAt: opened, resolvedAt: null },
  ]);
  const t = testApp({ scopes, models: { incident, incidentEvent: events, alertEvent: alerts } });
  return { ...t, incidents, alerts: alerts.rows };
}

describe('incidents', () => {
  it('lists the org’s incidents only, and filters by status', async () => {
    const t = setup(['read']);
    const r = await t.call('GET', '/incidents?status=open&limit=10');
    expect(r.status).toBe(200);
    expect(IncidentList.safeParse(r.json).success).toBe(true);
    expect(r.json.data.map((i: { id: string }) => i.id)).toEqual(['inc1']);
    expect(r.json.data[0]).toMatchObject({ status: 'open', severity: 'critical', event_count: 1, resolved_at: null });
    expect((await t.call('GET', '/incidents?limit=500')).status).toBe(400);
  });

  it('gets one with its timeline; another org’s is 404', async () => {
    const t = setup(['read']);
    const r = await t.call('GET', '/incidents/inc1');
    expect(IncidentDetailDto.safeParse(r.json).success).toBe(true);
    expect(r.json.events[0]).toMatchObject({ kind: 'opened', meta: { groupKey: 'alert:shop' } });
    expect((await t.call('GET', '/incidents/inc2')).status).toBe(404);
  });

  it('resolves with a message (body optional), audited; resolving twice is refused', async () => {
    const t = setup();
    const r = await t.call('POST', '/incidents/inc1/resolve', { message: 'Rolled back' });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('resolved');
    expect(r.json.events.at(-1)).toMatchObject({ kind: 'resolved', message: 'Rolled back' });
    expect(t.actions()).toEqual(['incidents.resolve']);
    expect((await t.call('POST', '/incidents/inc1/resolve')).status).toBe(400);
  });

  it('a read key cannot resolve (403)', async () => {
    expect((await setup(['read']).call('POST', '/incidents/inc1/resolve', {})).status).toBe(403);
  });
});

describe('incident + event mappers (golden)', () => {
  it('maps camelCase views → snake_case DTOs', () => {
    expect(
      incidentToDto({
        id: 'i1', title: 't', status: 'resolved', severity: 'major', summary: 's', openedAt: 'a', resolvedAt: 'b',
        durationSec: 9, eventCount: 2, lastEventAt: 'c', owner: null,
      }),
    ).toEqual({
      id: 'i1', title: 't', status: 'resolved', severity: 'major', summary: 's', opened_at: 'a', resolved_at: 'b',
      duration_sec: 9, event_count: 2, last_event_at: 'c',
    });
    expect(
      alertEventToDto({
        id: 'e1', ruleId: null, ruleName: null, signal: 'node-offline', severity: 'warning', resource: 'node:w1',
        message: 'm', status: 'firing', notify: 'held', firedAt: 'a', resolvedAt: null,
      }),
    ).toEqual({
      id: 'e1', rule_id: null, rule_name: null, signal: 'node-offline', severity: 'warning', resource: 'node:w1',
      message: 'm', status: 'firing', notify: 'held', fired_at: 'a', resolved_at: null,
    });
  });
});

describe('alert events', () => {
  it('lists and acknowledges an event (manually resolved, audited)', async () => {
    const t = setup();
    const l = await t.call('GET', '/alert-events?status=firing');
    expect(l.json.data).toHaveLength(1);
    const a = await t.call('POST', '/alert-events/ae1/acknowledge');
    expect(a.status).toBe(200);
    expect(AlertEventDto.safeParse(a.json).success).toBe(true);
    expect(a.json).toMatchObject({ id: 'ae1', status: 'resolved', rule_name: 'Shop down', notify: 'sent' });
    expect(t.actions()).toEqual(['alerts.ack']);
    expect((await t.call('POST', '/alert-events/nope/acknowledge')).status).toBe(404);
  });
});
