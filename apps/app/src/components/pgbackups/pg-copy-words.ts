/**
 * Pure: a database's second copy in words (board 40: "Off-site copy · 4 min
 * behind"), from `dbBackups.overview`'s `copy`. The lag rule is the
 * controller's (`dbBackupCopy.view.ts`); this only says it.
 */
import type { DbBackupCopyView, DbBackupScheduleView } from '@swarmy/core';
import type { Tone } from '@/components/calm/tone';
import { NATIVE_TARGET_NAME } from '@/components/backups/native-target-name';
import { lagWords } from '@/components/backups/copy-lag-words';
import { fmtBytes } from '@/components/backups/backup-format';

const MIN = 60_000;
/** A nightly copy that missed one run is this far behind. */
const STALE_MS = 26 * 60 * MIN;

/** Outside your servers: an S3 bucket that isn't swarmy's own store. */
export function isOffsite(t: { kind: string; name: string }): boolean {
  return t.kind.toLowerCase() === 's3' && t.name !== NATIVE_TARGET_NAME;
}

/** Mirror of the controller's `copyMethod`: how a schedule on this engine is copied, or null when it can't be. */
export function pgCopyMethod(engine: DbBackupScheduleView['engine']): 'dump' | 'walg-copy' | null {
  return engine === 'pg_dump' || engine === 'pg_dumpall' || engine === 'snapshot-from-replica' ? 'dump' : null;
}

const utc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** The copy's sentence, tone and tech line. */
export function pgCopyLine(c: DbBackupCopyView, offsite: boolean): { say: string; tone: Tone; tech: string } {
  const lead = offsite ? 'Off-site copy' : 'Second copy';
  const tech = [
    c.method === 'dump' ? 'a second dump after each save' : 'wal-g copy after each base backup',
    c.newestCopyAt ? `newest copy ${utc(c.newestCopyAt)}` : null,
    c.sizeBytes ? fmtBytes(c.sizeBytes) : null,
    c.lastError ? `last error: ${c.lastError}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (c.failing) return { say: `${lead} · the last copy failed`, tone: 'bad', tech };
  if (c.neverCopied) return { say: `${lead} · not copied yet`, tone: 'warn', tech };
  if (c.behindMs == null) return { say: c.copying ? `${lead} · copying now` : `${lead} · nothing saved yet`, tone: 'idle', tech };
  const behind = c.behindMs < MIN ? 'up to date' : `${lagWords(c.behindMs)} behind`;
  const reach = c.restoresTo ? `restores to ${utc(c.restoresTo)}, ` : '';
  return { say: `${lead} · ${reach}${behind}${c.copying ? ' · copying now' : ''}`, tone: c.behindMs > STALE_MS ? 'warn' : 'ok', tech };
}
