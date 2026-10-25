import type { HttpTransport } from './http.js';
import type {
  AlertRule,
  AlertRuleList,
  CreateAlertRuleRequest,
  CreateNotificationChannelRequest,
  NotificationChannel,
  NotificationChannelList,
  Removed,
  UpdateAlertRuleRequest,
  UpdateNotificationChannelRequest,
} from './models.js';

/** Alert rules (`/alert-rules`): several per signal, each narrowed by its own target. */
export class AlertRulesResource {
  constructor(private readonly http: HttpTransport) {}

  /** Every rule (the per-signal defaults are seeded on first call). */
  list(): Promise<AlertRuleList> {
    return this.http.request<AlertRuleList>('GET', '/alert-rules');
  }

  get(id: string): Promise<AlertRule> {
    return this.http.request<AlertRule>('GET', `/alert-rules/${encodeURIComponent(id)}`);
  }

  /** Add a rule for a signal, optionally narrowed to one app/part or server (201). */
  create(body: CreateAlertRuleRequest): Promise<AlertRule> {
    return this.http.request<AlertRule>('POST', '/alert-rules', { body });
  }

  /** Change the fields given; `threshold: null` clears it, `selector: {}` widens to any. */
  update(id: string, body: UpdateAlertRuleRequest): Promise<AlertRule> {
    return this.http.request<AlertRule>('PATCH', `/alert-rules/${encodeURIComponent(id)}`, { body });
  }

  /** Delete a rule; a seeded default is opted out and never re-created. */
  remove(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/alert-rules/${encodeURIComponent(id)}`);
  }
}

/** Notification channels (`/notification-channels`). The destination is write-only. */
export class NotificationChannelsResource {
  constructor(private readonly http: HttpTransport) {}

  /** Every channel (redacted targets only). */
  list(): Promise<NotificationChannelList> {
    return this.http.request<NotificationChannelList>('GET', '/notification-channels');
  }

  get(id: string): Promise<NotificationChannel> {
    return this.http.request<NotificationChannel>('GET', `/notification-channels/${encodeURIComponent(id)}`);
  }

  /** Add a channel (201); it starts enabled. */
  create(body: CreateNotificationChannelRequest): Promise<NotificationChannel> {
    return this.http.request<NotificationChannel>('POST', '/notification-channels', { body });
  }

  /** Rename, enable/disable or repoint (same kind only) a channel. */
  update(id: string, body: UpdateNotificationChannelRequest): Promise<NotificationChannel> {
    return this.http.request<NotificationChannel>('PATCH', `/notification-channels/${encodeURIComponent(id)}`, { body });
  }

  remove(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/notification-channels/${encodeURIComponent(id)}`);
  }
}
