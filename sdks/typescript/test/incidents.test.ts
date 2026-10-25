import { B, list, runCases } from './harness.js';

const incident = {
  id: 'inc 1', title: 'Shop is down', status: 'open', severity: 'critical', summary: null,
  opened_at: '2026-10-01T00:00:00.000Z', resolved_at: null, duration_sec: 60, event_count: 1, last_event_at: null,
};
const detail = { ...incident, events: [{ id: 'e1', at: '2026-10-01T00:00:00.000Z', kind: 'opened', message: 'm', meta: {} }] };
const event = {
  id: 'ae1', rule_id: 'ar1', rule_name: 'Shop down', signal: 'service-down', severity: 'critical', resource: 'shop',
  message: 'down', status: 'resolved', notify: 'sent', fired_at: '2026-10-01T00:00:00.000Z', resolved_at: null,
};

runCases('incidents and alert events', [
  { name: 'incidents.list', call: (c) => c.incidents.list({ status: 'open', limit: 10 }), response: list([incident]),
    request: `GET ${B}/incidents?status=open&limit=10`, check: (o) => o.data[0].severity, want: 'critical' },
  { name: 'incidents.get', call: (c) => c.incidents.get('inc 1'), response: detail,
    request: `GET ${B}/incidents/inc%201`, check: (o) => o.events[0].kind, want: 'opened' },
  { name: 'incidents.resolve', call: (c) => c.incidents.resolve('inc1', { message: 'Rolled back' }),
    response: { ...detail, status: 'resolved' }, request: `POST ${B}/incidents/inc1/resolve`,
    body: { message: 'Rolled back' }, check: (o) => o.status, want: 'resolved' },
  { name: 'alertEvents.list', call: (c) => c.alertEvents.list(), response: list([event]),
    request: `GET ${B}/alert-events`, check: (o) => o.data[0].rule_name, want: 'Shop down' },
  { name: 'alertEvents.acknowledge', call: (c) => c.alertEvents.acknowledge('ae1'), response: event,
    request: `POST ${B}/alert-events/ae1/acknowledge`, check: (o) => o.status, want: 'resolved' },
]);
