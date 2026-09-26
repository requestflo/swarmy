import type { IncidentUpdatePhase, PublicComponentView, PublicStatusView, StatusPageView } from '@swarmy/core';
import type { Tone } from '@/components/calm';

export const PHASE_LABEL: Record<IncidentUpdatePhase, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

export const PHASE_TONE: Record<IncidentUpdatePhase, Tone> = {
  investigating: 'warn',
  identified: 'warn',
  monitoring: 'info',
  resolved: 'ok',
};

/** The address a visitor types: the custom domain, else the swarmy path. */
export function pageAddress(page: Pick<StatusPageView, 'domain' | 'publicPath'>): string {
  return page.domain ?? page.publicPath;
}

/** "Checkout and API" / "Checkout, API and 2 more". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

const hurt = (cs: PublicComponentView[], s: 'down' | 'degraded'): string[] => cs.filter((c) => c.status === s).map((c) => c.label);

/** The public banner sentence: "Checkout is degraded — other systems are fine". */
export function bannerSentence(snap: Pick<PublicStatusView, 'components' | 'overall'>): string {
  const down = hurt(snap.components, 'down');
  const degraded = hurt(snap.components, 'degraded');
  const others = snap.components.length > down.length + degraded.length ? ' — other systems are fine' : '';
  if (down.length) return `${nameList(down)} ${down.length === 1 ? 'is' : 'are'} down${degraded.length ? `, ${nameList(degraded)} degraded` : others}`;
  if (degraded.length) return `${nameList(degraded)} ${degraded.length === 1 ? 'is' : 'are'} degraded${others}`;
  if (snap.overall === 'unknown') return 'No status data yet';
  return 'All systems operational';
}

/** What visitors see, as a short dashboard phrase: "all systems normal" / "Checkout degraded". */
export function visitorPhrase(snap: Pick<PublicStatusView, 'components' | 'overall'>): { text: string; tone: Tone } {
  const down = hurt(snap.components, 'down');
  const degraded = hurt(snap.components, 'degraded');
  if (down.length) return { text: `${nameList(down)} down`, tone: 'bad' };
  if (degraded.length) return { text: `${nameList(degraded)} degraded`, tone: 'warn' };
  if (snap.overall === 'unknown') return { text: 'no status yet', tone: 'idle' };
  return { text: 'all systems normal', tone: 'ok' };
}

/** "10:24" local clock for the preview's update lines. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
