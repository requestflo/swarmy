import type { IncidentDetailView } from '@swarmy/core';
import { splitServiceName, type WordsContext } from './incident-words';

/** What an incident is about, derived from its timeline (the model has no app link). */
export interface IncidentScope {
  /** The app (stack) it hit, when derivable. */
  app: string | null;
  /** The part (service, short name) that is failing, when named. */
  part: string | null;
  /** Signals seen on its timeline (`error-rate`, `replicas`, `service-down`, …). */
  signals: string[];
  /** The release it names (`rel-store-6`), when one is named. */
  releaseId: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Read the app / part / signals / release out of the incident's events:
 * `meta.stackName`, a `release:<app>` or `alert:service:<name>` group key,
 * `service:<name>` keys in the messages, `meta.signal`, `meta.releaseId`.
 */
export function incidentScope(incident: Pick<IncidentDetailView, 'title' | 'events'>, ctx: WordsContext): IncidentScope {
  let app: string | null = null;
  let part: string | null = null;
  let releaseId: string | null = null;
  const signals = new Set<string>();
  for (const e of incident.events) {
    const m = e.meta;
    const signal = str(m.signal);
    if (signal) signals.add(signal);
    releaseId ??= str(m.releaseId);
    app ??= str(m.stackName);
    const group = str(m.groupKey);
    if (!app && group?.startsWith('release:')) app = group.slice('release:'.length);
    const service = (group?.startsWith('alert:service:') ? group.slice('alert:service:'.length) : null) ?? str(m.resource)?.replace(/^service:/, '') ?? /\bservice:([\w.-]+)/.exec(e.message)?.[1] ?? null;
    if (service && !part) {
      const split = splitServiceName(service, ctx);
      part = split.part;
      app ??= split.app;
    }
  }
  if (!app) {
    const failedDeploy = /^Failed deploy on (.+)$/.exec(incident.title)?.[1];
    const serviceTitle = /^Service (.+) disruption$/.exec(incident.title)?.[1];
    if (failedDeploy) app = failedDeploy;
    else if (serviceTitle) {
      const split = splitServiceName(serviceTitle, ctx);
      app = split.app;
      part ??= split.part;
    }
  }
  return { app, part, signals: [...signals], releaseId };
}

export type IncidentMetric = 'errors' | 'latency';

/** The metric that best explains it: latency signals chart p95, everything else the error rate. */
export function incidentMetric(scope: IncidentScope, title: string): IncidentMetric | null {
  if (!scope.app) return null;
  if (scope.signals.some((s) => /latency|p95|duration|slow/.test(s)) || /\bslow\b/i.test(title)) return 'latency';
  return 'errors';
}
