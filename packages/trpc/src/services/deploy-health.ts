/**
 * PURE: the controller-owned tail of a traced deploy — the route's address +
 * certificate and the final health check — as change-only events. Fed a
 * snapshot of Docker truth (the stack's live services) and the route's
 * verification state (`ingress.listDomains`), it says what's new since the
 * last snapshot, so a tick at steady state emits nothing.
 *
 * Health = every service at its wanted copies AND (no address, or the edge
 * serving it with its certificate settled). That's when the deploy is live.
 */
import type { DeployEventStatus } from '@swarmy/core/protocol';

export interface HealthSnapshot {
  /** The stack's services as Docker reports them. */
  services: Array<{ name: string; running: number; desired: number }>;
  /** Every service the deploy created is visible in the inventory. */
  allVisible: boolean;
  /** The server a pinned deploy went to ("2/2 services running on wkr-2"). */
  server?: string;
  domain: {
    host: string;
    tls: string;
    serving: boolean;
    state: string | null;
    certIssuer: string | null;
    certError: string | null;
  } | null;
}

export interface HealthMemo {
  route: string | null;
  health: string | null;
}

export interface HealthEvent {
  stage: 'route' | 'health';
  status: DeployEventStatus;
  message: string;
  host?: string;
}

type RouteState = { key: string; status: DeployEventStatus; message: string; settled: boolean } | null;

function routeState(d: HealthSnapshot['domain']): RouteState {
  if (!d) return null;
  const h = d.host;
  if (d.tls === 'off') return { key: 'plain', status: 'done', message: `http://${h} · plain HTTP, no certificate`, settled: true };
  if (d.state === 'error' || d.certError) {
    return { key: `err:${d.certError ?? ''}`, status: 'failed', message: `certificate for ${h}: ${d.certError ?? 'the check failed'}`, settled: true };
  }
  if (d.state === 'active' || (d.certIssuer && !d.certError)) {
    return { key: 'active', status: 'done', message: `certificate for ${h} issued${d.certIssuer ? ` by ${d.certIssuer}` : ''}`, settled: true };
  }
  if (d.state === 'waiting_dns') return { key: 'dns', status: 'progress', message: `waiting for ${h} to point at your servers`, settled: false };
  if (d.state === 'issuing' || d.state === 'verified') return { key: 'issuing', status: 'progress', message: `asking Let’s Encrypt for ${h}`, settled: false };
  return { key: 'added', status: 'started', message: `route https://${h} added`, settled: false };
}

/** What changed since `memo`; returns the events and the next memo. */
export function nextHealthEvents(memo: HealthMemo, snap: HealthSnapshot): { events: HealthEvent[]; memo: HealthMemo; live: boolean } {
  const events: HealthEvent[] = [];
  const next: HealthMemo = { ...memo };
  const route = routeState(snap.domain);
  if (route && route.key !== memo.route) {
    if (memo.route === null && route.status !== 'started') {
      events.push({ stage: 'route', status: 'started', message: `route https://${snap.domain!.host} added`, host: snap.domain!.host });
    }
    events.push({ stage: 'route', status: route.status, message: route.message, host: snap.domain!.host });
    next.route = route.key;
  }

  const up = snap.services.filter((s) => s.desired > 0 && s.running >= s.desired).length;
  const allUp = snap.allVisible && snap.services.length > 0 && up === snap.services.length;
  const routeOk = snap.allVisible && (route === null ? true : route.settled && route.status === 'done' && snap.domain!.serving);
  const live = allUp && routeOk;
  const n = `${up}/${snap.services.length} services running${snap.server ? ` on ${snap.server}` : ''}`;
  if (allUp && memo.health === null) {
    events.push({ stage: 'health', status: 'started', message: snap.domain ? `checking ${n} and ${snap.domain.host}` : `checking ${n}` });
    next.health = 'checking';
  }
  if (live && memo.health !== 'live') {
    events.push({ stage: 'health', status: 'done', message: snap.domain ? `${n} · ${snap.domain.host} answering` : `${n} · it’s live` });
    next.health = 'live';
  }
  return { events, memo: next, live };
}
