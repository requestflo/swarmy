import type { AlertEventView, AuditEntryView, IncidentView } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { humanizeAction } from '@/components/auditlog/humanize';

export type ActivityKind = 'deploy' | 'alert' | 'incident' | 'backup' | 'change';

/** The Stream's filter chips (Changes only show under All). */
export const STREAM_FILTERS = ['all', 'alert', 'incident', 'deploy', 'backup'] as const;
export type StreamFilter = (typeof STREAM_FILTERS)[number];

/** One line on the Stream, whatever it came from. */
export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  tone: Tone;
  title: string;
  say: string;
  /** The pill word (ok · firing · open · suspect · resolved · failed); '' = no pill. */
  word: string;
  /** Controls-depth line: actor · raw action · target. */
  tech: string;
  /** Incident rows open the incident room beside the stream. */
  incidentId?: string;
  /** App the line is about, when known (deploys: the stack). */
  app?: string;
  to?: string;
  raw: AlertEventView | IncidentView | AuditEntryView;
}

/** The change itself, compact (Controls depth). */
function diff(meta: Record<string, unknown>): string {
  const j = JSON.stringify(meta);
  if (!j || j === '{}') return '';
  return ` · ${j.length > 140 ? `${j.slice(0, 139)}…` : j}`;
}

const isDeploy = (a: string): boolean => /deploy|rollback/i.test(a);
const isBackup = (a: string): boolean => /backup|restore/i.test(a);

export function fromAlert(e: AlertEventView): ActivityItem {
  const firing = e.status === 'firing';
  return {
    id: `alert-${e.id}`, at: e.firedAt, kind: 'alert', raw: e,
    tone: firing ? (e.severity === 'critical' ? 'bad' : 'warn') : 'idle',
    title: e.ruleName ?? e.signal,
    say: e.message,
    word: firing ? 'firing' : 'resolved',
    tech: `alert · ${e.signal} · ${e.resource} · ${e.severity}`,
    to: '/alerts',
  };
}

export function fromIncident(i: IncidentView): ActivityItem {
  const open = i.status === 'open';
  return {
    id: `inc-${i.id}`, at: i.openedAt, kind: 'incident', raw: i,
    tone: open ? (i.severity === 'minor' ? 'warn' : 'bad') : 'idle',
    title: i.title,
    say: open ? `${i.eventCount} steps on its timeline so far` : (i.summary ?? `Resolved after ${i.eventCount} steps`),
    word: open ? 'open' : 'resolved',
    tech: `incident · ${i.id} · ${i.severity}`,
    incidentId: i.id,
  };
}

export function fromAudit(a: AuditEntryView): ActivityItem {
  const deploy = isDeploy(a.action);
  const backup = !deploy && isBackup(a.action);
  const failed = /fail|denied|blocked/i.test(a.action);
  return {
    id: `audit-${a.id}`, at: a.ts, kind: deploy ? 'deploy' : backup ? 'backup' : 'change', raw: a,
    tone: failed ? 'bad' : deploy ? 'info' : backup ? 'ok' : 'idle',
    title: a.targetId ?? a.action,
    say: `${a.actorLabel} ${humanizeAction(a)}`.replace(/ stack /, ' app '),
    word: failed ? 'failed' : deploy || backup ? 'ok' : '',
    tech: `${a.actorType}:${a.actorId ?? '—'} · ${a.action}${a.targetType ? ` · ${a.targetType}/${a.targetId ?? ''}` : ''}${diff(a.metadata)}`,
    app: deploy && a.targetType === 'stack' && a.targetId ? a.targetId : undefined,
    to: '/audit',
  };
}

/**
 * A deploy of an app in the two hours before an open incident on that app is
 * the likely cause: its pill reads "suspect". `incidentApps` maps an open
 * incident's opened-at to the app it names (when the title names one).
 */
export function markSuspects(items: ActivityItem[], incidentApps: { app: string; openedAt: string }[]): ActivityItem[] {
  if (incidentApps.length === 0) return items;
  return items.map((it) => {
    if (it.kind !== 'deploy' || !it.app || it.word === 'failed') return it;
    const t = new Date(it.at).getTime();
    const hit = incidentApps.some((x) => x.app === it.app && t <= new Date(x.openedAt).getTime() && new Date(x.openedAt).getTime() - t <= 2 * 3_600_000);
    return hit ? { ...it, word: 'suspect', tone: 'warn' } : it;
  });
}
