import type { AuditEntryView, ReleaseView } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { imageTag, personName } from '@/components/apps/app-words';

export interface TodayItem {
  id: string;
  at: string;
  tone: Tone;
  say: string;
  /** Controls line: the raw action / images. */
  tech: string;
  to: string;
  params?: Record<string, string>;
}

const RELEASE_SAY: Record<ReleaseView['status'], { tone: Tone; say: string }> = {
  healthy: { tone: 'ok', say: 'All good.' },
  superseded: { tone: 'ok', say: 'All good.' },
  deploying: { tone: 'info', say: 'Rolling out now.' },
  failed: { tone: 'bad', say: 'It didn’t go live.' },
  'rolled-back': { tone: 'warn', say: 'It was put back.' },
};

const BACKUP_ACTIONS = new Set(['backup.run', 'db.backup', 'controller.backup.run']);

export function fromRelease(r: ReleaseView): TodayItem {
  const tag = r.images[0] ? imageTag(r.images[0].image) : null;
  const s = RELEASE_SAY[r.status];
  return {
    id: `rel-${r.id}`,
    at: r.createdAt,
    tone: s.tone,
    say: `${personName(r.actor)} changed ${r.stackName}${tag ? ` (${tag})` : ''}. ${s.say}`,
    tech: `release ${r.id} · ${r.status} · ${r.images.map((i) => i.image).join(', ')}`,
    to: '/stacks/$name/releases',
    params: { name: r.stackName },
  };
}

export function fromBackup(e: AuditEntryView): TodayItem {
  const what = e.action === 'controller.backup.run' ? 'swarmy’s own settings' : (e.targetId ?? 'your data');
  return {
    id: `audit-${e.id}`,
    at: e.ts,
    tone: 'ok',
    say: `Backed up ${what}.`,
    tech: `${e.action} · ${e.targetType ?? ''} ${e.targetId ?? ''}`.trim(),
    to: '/backups',
  };
}

/** The last day's changes and backups, newest first (the last few, if the day was quiet). */
export function todayItems(releases: ReleaseView[], audit: AuditEntryView[], now = Date.now()): { items: TodayItem[]; today: boolean } {
  const all = [...releases.map(fromRelease), ...audit.filter((e) => BACKUP_ACTIONS.has(e.action)).map(fromBackup)].sort(
    (a, b) => b.at.localeCompare(a.at),
  );
  const day = all.filter((i) => now - new Date(i.at).getTime() < 24 * 3_600_000);
  return day.length ? { items: day.slice(0, 6), today: true } : { items: all.slice(0, 4), today: false };
}
