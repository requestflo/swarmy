import type { AlertEventView, AuditEntryView, IncidentView } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { humanizeAction } from '@/components/auditlog/humanize';

export type ActivityKind = 'deploy' | 'alert' | 'incident' | 'change';

/** One line on the Activity timeline, whatever it came from. */
export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  tone: Tone;
  title: string;
  say: string;
  word: string;
  /** Controls-depth line: actor · raw action · target. */
  tech: string;
  to?: string;
  params?: Record<string, string>;
  raw: AlertEventView | IncidentView | AuditEntryView;
}

/** The change itself, compact (Controls depth). */
function diff(meta: Record<string, unknown>): string {
  const j = JSON.stringify(meta);
  if (!j || j === '{}') return '';
  return ` · ${j.length > 140 ? `${j.slice(0, 139)}…` : j}`;
}

const isDeploy = (a: string): boolean => /deploy|rollback/i.test(a);

export function fromAlert(e: AlertEventView): ActivityItem {
  const firing = e.status === 'firing';
  return {
    id: `alert-${e.id}`, at: e.firedAt, kind: 'alert', raw: e,
    tone: firing ? (e.severity === 'critical' ? 'bad' : 'warn') : 'ok',
    title: e.ruleName ?? e.signal,
    say: e.message,
    word: firing ? 'Firing' : 'Resolved',
    tech: `alert · ${e.signal} · ${e.resource} · ${e.severity}`,
    to: '/alerts',
  };
}

export function fromIncident(i: IncidentView): ActivityItem {
  const open = i.status === 'open';
  return {
    id: `inc-${i.id}`, at: i.openedAt, kind: 'incident', raw: i,
    tone: open ? (i.severity === 'minor' ? 'warn' : 'bad') : 'ok',
    title: i.title,
    say: open ? `${i.eventCount} steps on its timeline so far` : (i.summary ?? `Resolved after ${i.eventCount} steps`),
    word: open ? 'Open' : 'Resolved',
    tech: `incident · ${i.id} · ${i.severity}`,
    to: '/incidents/$incidentId', params: { incidentId: i.id },
  };
}

export function fromAudit(a: AuditEntryView): ActivityItem {
  const deploy = isDeploy(a.action);
  const failed = /fail|denied|blocked/i.test(a.action);
  return {
    id: `audit-${a.id}`, at: a.ts, kind: deploy ? 'deploy' : 'change', raw: a,
    tone: failed ? 'bad' : deploy ? 'info' : 'idle',
    title: a.targetId ?? a.action,
    say: `${a.actorLabel} ${humanizeAction(a)}`.replace(/ stack /, ' app '),
    word: failed ? 'Failed' : deploy ? 'Deployed' : '',
    tech: `${a.actorType}:${a.actorId ?? '—'} · ${a.action}${a.targetType ? ` · ${a.targetType}/${a.targetId ?? ''}` : ''}${diff(a.metadata)}`,
    to: '/audit',
  };
}
