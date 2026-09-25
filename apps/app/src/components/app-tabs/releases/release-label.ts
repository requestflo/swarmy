import type { ReleaseView } from '@swarmy/core';
import type { Tone } from '@/components/calm';

/** "ghcr.io/northwind/web:1.9.0" → "v1.9.0"; digests and odd tags stay as they are. */
export function releaseLabel(r: ReleaseView | undefined): string {
  const image = r?.images[0]?.image;
  if (!image) return 'this version';
  const at = image.lastIndexOf('@');
  if (at > 0) return image.slice(at + 1, at + 20);
  const tag = image.slice(image.lastIndexOf(':') + 1);
  if (!tag || tag.includes('/')) return 'latest';
  return /^\d/.test(tag) ? `v${tag}` : tag;
}

/** "calum@gomacrae.com" → "calum"; null → "swarmy". */
export function actorName(actor: string | null): string {
  if (!actor) return 'swarmy';
  return actor.includes('@') ? actor.slice(0, actor.indexOf('@')) : actor;
}

export const RELEASE_TONE: Record<ReleaseView['status'], Tone> = {
  deploying: 'info',
  healthy: 'ok',
  failed: 'bad',
  'rolled-back': 'warn',
  superseded: 'idle',
};

export const RELEASE_WORD: Record<ReleaseView['status'], string> = {
  deploying: 'Deploying',
  healthy: 'Live',
  failed: 'Failed',
  'rolled-back': 'Put back',
  superseded: 'Replaced',
};

/** The version to put back to: the newest earlier one that ran healthy. */
export function lastGood(rows: ReleaseView[]): ReleaseView | undefined {
  return rows.slice(1).find((r) => r.status === 'healthy' || r.status === 'superseded');
}

/** "2 hours ago" — the sentence form (lists keep the short "2h ago"). */
export function agoWords(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  const say = (n: number, u: string): string => `${n} ${u}${n === 1 ? '' : 's'} ago`;
  if (mins < 1) return 'just now';
  if (mins < 60) return say(mins, 'minute');
  const h = Math.round(mins / 60);
  return h < 24 ? say(h, 'hour') : say(Math.round(h / 24), 'day');
}
