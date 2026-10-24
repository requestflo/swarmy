/** Funnel types and the pure helpers behind the funnel card and editor. */
import type { inferInput, inferOutput, TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@swarmy/trpc';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';

type Rum = TRPCOptionsProxy<AppRouter>['rum'];
type Errors = TRPCOptionsProxy<AppRouter>['errors'];

export type FunnelView = inferOutput<Rum['funnel']>;
export type Funnel = inferOutput<Rum['getFunnels']>['funnels'][number];
/** What the editor holds: a funnel as typed (`windowMinutes` may be left to its default). */
export type FunnelDraft = inferInput<Rum['setFunnels']>['funnels'][number];
export type FunnelDraftStep = FunnelDraft['steps'][number];
export type IssueRow = inferOutput<Errors['issues']>['issues'][number];

/** Mirrors `MAX_FUNNELS` / `MIN_FUNNEL_STEPS` / `MAX_FUNNEL_STEPS` / `FUNNEL_WINDOW_CHOICES` in @swarmy/rum. */
export const MAX_FUNNELS = 5;
export const MIN_STEPS = 2;
export const MAX_STEPS = 8;
export const WINDOW_CHOICES = [
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 1440, label: '1 day' },
];

/** Same rule as the server's path schema: starts with `/`, no spaces, quotes or backslashes. */
export const PATH_RE = /^\/[^\s'"`\\<>]*$/;
export const EVENT_RE = /^[\w.:\- ]+$/;

/** An error spike worth naming next to the drop: at least this many events in 24 h (the spike alert's floor). */
export const SPIKE_MIN_24H = 20;

/** "v1.9.0" for a release's first image; "earlier" for visits before any release swarmy knows. */
export function versionLabel(image: string | null): string {
  if (!image) return 'earlier';
  return releaseLabel({ images: [{ name: '', image }] });
}

/** "Biggest drop: checkout → paid" + ", since v1.9.0" only when the funnel read found one. */
export function dropSentence(v: FunnelView): { drop: string; since: string | null } | null {
  if (!v.biggestDrop) return null;
  const drop = `Biggest drop: ${v.biggestDrop.from} → ${v.biggestDrop.to}`;
  return { drop, since: v.since ? versionLabel(v.since.image) : null };
}

/**
 * The error to open beside the drop: an unresolved issue that started (or came
 * back) after the release the drop worsened with, spiking in the last 24 h.
 * Errors carry no page path in the issue list, so the tie is the release, and
 * without a "since" there is no link.
 */
export function spikeIssue(issues: readonly IssueRow[], sinceAt: string | null): IssueRow | null {
  if (!sinceAt) return null;
  const t = Date.parse(sinceAt);
  const fresh = (iso: string | null) => (iso ? Date.parse(iso) >= t : false);
  const hits = issues.filter((i) => i.status === 'unresolved' && i.count24h >= SPIKE_MIN_24H && (fresh(i.firstSeen) || fresh(i.regressedAt)));
  return hits.sort((a, b) => b.count24h - a.count24h)[0] ?? null;
}

/** "Checkout" → "checkout", unique among `taken` ("checkout-2"). */
export function funnelId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'funnel';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** A starter the editor opens with: the shape most shops have. */
export function starterFunnel(taken: readonly string[]): FunnelDraft {
  return { id: funnelId('Checkout', taken), name: 'Checkout', windowMinutes: 60, steps: [{ path: '/cart' }, { path: '/checkout' }, { path: '/checkout/done' }] };
}

/** Move step `i` one place up (−1) or down (+1); out of range leaves it. */
export function moveStep<T>(steps: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= steps.length) return [...steps];
  const next = [...steps];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Why a draft can't be saved yet, or null. */
export function draftProblem(f: FunnelDraft): string | null {
  if (!f.name.trim()) return 'Give the funnel a name.';
  if (f.steps.length < MIN_STEPS) return `A funnel needs at least ${MIN_STEPS} steps.`;
  const bad = f.steps.findIndex((s) => !PATH_RE.test(s.path));
  if (bad >= 0) return `Step ${bad + 1}: a path starts with / and has no spaces or quotes.`;
  const badEvent = f.steps.findIndex((s) => s.event && !EVENT_RE.test(s.event));
  if (badEvent >= 0) return `Step ${badEvent + 1}: an event name is letters, digits, space and . : - _ only.`;
  return null;
}

/** The label value at Code depth: what the server stores (event/name dropped when blank). */
export function funnelsLabel(funnels: readonly Funnel[]): string {
  return JSON.stringify(funnels);
}

/** "Checkout" → "Checkout funnel"; a name that already says funnel stays. */
export function funnelTitle(name: string): string {
  return /funnel$/i.test(name.trim()) ? name.trim() : `${name.trim()} funnel`;
}
