import type { HttpTransport } from './http.js';
import type { AlertEvent, AlertEventList, IncidentDetail, IncidentList, ResolveIncidentRequest } from './models.js';

/** Incidents (`/incidents`): read the story, resolve it. */
export class IncidentsResource {
  constructor(private readonly http: HttpTransport) {}

  /** Incidents, open first then newest; optionally one status only. */
  list(opts: { status?: 'open' | 'resolved'; limit?: number } = {}): Promise<IncidentList> {
    return this.http.request<IncidentList>('GET', '/incidents', { query: { status: opts.status, limit: opts.limit } });
  }

  /** One incident with its timeline (oldest event first). */
  get(id: string): Promise<IncidentDetail> {
    return this.http.request<IncidentDetail>('GET', `/incidents/${encodeURIComponent(id)}`);
  }

  /** Resolve an open incident; `message` goes on its timeline. */
  resolve(id: string, body: ResolveIncidentRequest = {}): Promise<IncidentDetail> {
    return this.http.request<IncidentDetail>('POST', `/incidents/${encodeURIComponent(id)}/resolve`, { body });
  }
}

/** Alert events (`/alert-events`): the firing/resolved feed. */
export class AlertEventsResource {
  constructor(private readonly http: HttpTransport) {}

  /** Events, newest first; optionally firing or resolved only. */
  list(opts: { status?: 'firing' | 'resolved'; limit?: number } = {}): Promise<AlertEventList> {
    return this.http.request<AlertEventList>('GET', '/alert-events', { query: { status: opts.status, limit: opts.limit } });
  }

  /** Acknowledge (manually resolve) a firing event; no recovery notification is sent. */
  acknowledge(id: string): Promise<AlertEvent> {
    return this.http.request<AlertEvent>('POST', `/alert-events/${encodeURIComponent(id)}/acknowledge`);
  }
}
