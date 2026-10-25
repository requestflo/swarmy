import { pgMemorySettings } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { PgTopoMember } from './pg-topology';

/**
 * The memory line of a Postgres page's Size section (board 39): the limit per
 * copy, the settings swarmy sizes from it, and how far the rolling restart
 * has got. The 25% / 75% rule is core's `pgMemorySettings` — the page never
 * keeps its own copy. PURE — tested in pg-memory.test.ts.
 */

/** The sizes the picker offers, MB (null = no limit). */
export const MEMORY_CHOICES: readonly (number | null)[] = [512, 1024, 2048, 4096, 8192, 16384, 32768, null];

/** 512 → "512 MB", 2048 → "2 GB", 1536 → "1.5 GB", null → "no limit". */
export function memoryWord(mb: number | null): string {
  if (mb === null) return 'no limit';
  if (mb < 1024) return `${mb} MB`;
  const g = mb / 1024;
  return `${Number.isInteger(g) ? g : g.toFixed(1)} GB`;
}

export interface MemoryLine {
  /** "2 GB per copy" · "no limit". */
  label: string;
  hint: string;
  tone: Tone;
  /** Mono, Controls up. */
  tech: string;
  /** Copies already at the declared size, of all copies; null at steady state. */
  progress: { done: number; total: number } | null;
}

export function memoryLine(c: { name: string; memoryMb?: number; members: readonly PgTopoMember[] }, inUseBytes: number | null): MemoryLine {
  const want = c.memoryMb ?? null;
  const copies = c.members.filter((m) => m.role !== 'dcs');
  const total = copies.reduce((n, m) => n + Math.max(1, m.desired), 0);
  const done = copies.filter((m) => (m.memoryMb ?? null) === want).reduce((n, m) => n + Math.max(1, m.desired), 0);
  const moving = done < total;
  const use = inUseBytes !== null ? `${memoryWord(Math.max(1, Math.round(inUseBytes / 1024 / 1024)))} in use by the main copy` : null;
  const s = want === null ? null : pgMemorySettings(want);
  return {
    label: want === null ? 'No limit' : `${memoryWord(want)} per copy`,
    hint: moving
      ? `Restarting copies for the new size: ${done} of ${total} done, the standby copies first.`
      : want === null
        ? `Each copy can use what its server has${use ? `; ${use}` : ''}.`
        : `${use ? `${use}. ` : ''}A quarter of it is Postgres’s own cache.`,
    tone: moving ? 'info' : 'ok',
    tech: s
      ? `swarmy.db.memoryMb=${want} · shared_buffers ${s.sharedBuffersMb}MB (25%) · effective_cache_size ${s.effectiveCacheSizeMb}MB (75%) · limit ${s.memoryBytes} B`
      : 'swarmy.db.memoryMb unset · shared_buffers 128MB (Postgres default) · no swarm memory limit',
    progress: moving ? { done, total } : null,
  };
}

/** What setting `mb` will do, for the button's confirmation line. */
export function memoryChangeWords(name: string, mb: number | null, copies: number): string {
  const restart = copies > 1 ? 'restarts the standby copies first, then the main copy in place' : 'restarts it in place';
  return `${name} moves to ${memoryWord(mb)}${mb === null ? '' : ' per copy'}: swarmy ${restart}, a few seconds without writes.`;
}
