import type { AuditEntryView } from '@swarmy/core';
import { relTime } from '@/lib/format';

/** Runs a person asked for — not the studio's own schema/browse/insights reads. */
const PEOPLE_ORIGINS = new Set(['console', 'edit', 'saved']);

export interface StudioActivityLine {
  id: string;
  who: string;
  what: string;
  statement: string;
  detail: string;
  at: string;
  failed: boolean;
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rows = (k: number) => `${k} ${k === 1 ? 'row' : 'rows'}`;

/**
 * The team's recent studio queries on one database, in words, from
 * `studio.query` audit rows (newest first). `studio.history` is only the
 * caller's own; this is anyone's.
 */
export function studioActivity(entries: AuditEntryView[], limit = 3): StudioActivityLine[] {
  const out: StudioActivityLine[] = [];
  for (const e of entries) {
    const m = e.metadata;
    if (e.action !== 'studio.query' || !PEOPLE_ORIGINS.has(String(m.origin))) continue;
    const failed = m.status !== 'ok';
    const cls = String(m.class);
    const affected = n(m.affected);
    const what =
      m.origin === 'edit'
        ? 'edited a row'
        : m.origin === 'saved'
          ? 'ran a saved query'
          : cls === 'destructive'
            ? 'ran a destructive statement'
            : cls === 'write'
              ? 'ran a write'
              : 'ran a read';
    const ms = n(m.durationMs);
    const count = cls === 'read' ? n(m.rows) : affected;
    const parts = failed
      ? ['failed']
      : [count != null ? (cls === 'read' ? rows(count) : `${rows(count)} changed`) : null, ms != null ? `${ms} ms` : null];
    out.push({
      id: e.id,
      who: e.actorLabel,
      what,
      statement: typeof m.statement === 'string' ? m.statement : '',
      detail: parts.filter(Boolean).join(' · '),
      at: relTime(e.ts),
      failed,
    });
    if (out.length >= limit) break;
  }
  return out;
}
