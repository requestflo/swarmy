import type { NodeSummary, ReleaseView } from '@swarmy/core';
import { actorName, releaseLabel } from '@/components/app-tabs/releases/release-label';
import { personName } from './app-words';

/**
 * Plain words for the Apps board's columns (servers, last deploy, traffic, the
 * needs-you diagnosis). Pure, so each column's wording is tested once.
 */

/** Requests a minute → "38 req/s" (at 60/min and up) or "12 req/min"; null → "no data yet", never 0. */
export function trafficValue(perMin: number | null | undefined): string {
  if (perMin === null || perMin === undefined || !Number.isFinite(perMin)) return 'no data yet';
  if (perMin >= 60) {
    const s = perMin / 60;
    return `${s >= 10 ? Math.round(s) : Math.round(s * 10) / 10} req/s`;
  }
  return `${perMin >= 10 ? Math.round(perMin) : Math.round(perMin * 10) / 10} req/min`;
}

/**
 * SVG path for a sparkline in a `w`×`h` box (2px inset). A null point is a gap
 * (the line lifts and starts again), never a zero. Empty when nothing is known.
 */
export function sparkPath(values: (number | null)[], w: number, h: number): string {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length === 0 || values.length === 0) return '';
  const max = Math.max(...known);
  const min = Math.min(...known);
  const span = max - min;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const y = (v: number): number => (span === 0 ? h / 2 : h - 2 - ((v - min) / span) * (h - 4));
  const parts: string[] = [];
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    parts.push(`${pen ? 'L' : 'M'}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`);
    pen = true;
  });
  return parts.join(' ');
}

export interface ServersWords {
  /** "london-2" for one server, "3 servers" for more. */
  primary: string;
  /** Regions ("eu-west · us-east"), or empty when none are labelled. */
  places: string;
  /** Only reachable over the private network: no address and no public IP. */
  privateOnly: boolean;
}

/** Where an app runs, from the servers its copies are on. Null = on none yet. */
export function serversWords(nodes: NodeSummary[], hasAddress: boolean): ServersWords | null {
  if (nodes.length === 0) return null;
  const regions = [...new Set(nodes.map((n) => n.region).filter((r): r is string => !!r))];
  return {
    primary: nodes.length === 1 ? nodes[0]!.name : `${nodes.length} servers`,
    places: regions.join(' · '),
    privateOnly: !hasAddress && nodes.every((n) => !n.publicIp),
  };
}

/** "14 min ago" · "3 h ago" · "yesterday" · "4 days ago". */
export function whenWords(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return 'yesterday';
  return `${Math.round(h / 24)} days ago`;
}

/** "14:02" in the viewer's clock. */
export function clockWords(iso: string | number): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface DeployWords {
  /** "v1.8.2 · 3 h ago" — the version that is live. */
  version: string;
  /** "Calum", or "swarmy" for automation. */
  who: string;
  /** "v1.9.0 deploying" while a new version rolls out. */
  inFlight: string | null;
}

/** Last deploy from an app's releases (newest first). Null when swarmy never deployed it. */
export function deployWords(rows: ReleaseView[], now = Date.now()): DeployWords | null {
  const head = rows[0];
  if (!head) return null;
  const live = head.status === 'deploying' ? (rows.find((r) => r.status !== 'deploying') ?? head) : head;
  const who = live.actor && live.actor !== 'system' ? personName(actorName(live.actor)) : 'swarmy';
  return {
    version: `${releaseLabel(live)} · ${whenWords(live.createdAt, now)}`,
    who,
    inFlight: head.status === 'deploying' && head !== live ? `${releaseLabel(head)} deploying` : null,
  };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const bare = (s: string): string => s.trim().replace(/[.\s]+$/, '').toLowerCase();

/**
 * The needs-you diagnosis: the health narrative's reasons the row's own
 * sentence doesn't already say, then what changed last (a fact, not a blame).
 */
export function diagnosisWords(input: { say: string; reasons: string[]; head?: ReleaseView; incident?: string | null }): string {
  const said = bare(input.say);
  const extra = input.reasons.filter((r) => bare(r) !== said).slice(0, 2);
  const why = extra.length ? `${cap(extra.join('; '))}.` : input.incident ? `${cap(bare(input.incident))}.` : '';
  const h = input.head;
  const change = !h
    ? ''
    : h.status === 'deploying'
      ? `${releaseLabel(h)} started rolling out at ${clockWords(h.createdAt)}.`
      : `The last change was ${releaseLabel(h)} at ${clockWords(h.createdAt)}.`;
  return [why, change].filter(Boolean).join(' ') || input.say;
}
