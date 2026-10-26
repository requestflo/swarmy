/**
 * What a detector found, in order of how sure it makes us: each signal is a
 * line of evidence (absent when that thing isn't in the repo) and the plain
 * words for it. The first signal present is the finding's reason — "uses
 * Prisma with PostgreSQL in prisma/schema.prisma" — and every present one is
 * its evidence.
 */
import type { Evidence } from './types';

export interface Signal {
  ev: Evidence | undefined;
  /** "uses Prisma with PostgreSQL" — the file is added. */
  says: string;
}

export function uniqEvidence(evs: Array<Evidence | undefined>, max = 4): Evidence[] {
  const seen = new Set<string>();
  return evs
    .filter((e): e is Evidence => {
      if (!e || seen.has(`${e.file}:${e.line}`)) return false;
      seen.add(`${e.file}:${e.line}`);
      return true;
    })
    .slice(0, max);
}

/** `services/orders/prisma/schema.prisma` → `prisma/schema.prisma` inside `services/orders`. */
export const relTo = (dir: string, file: string): string => (dir && file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file);

/** The finding's reason: the first present signal's words and where it is. */
export function reasonOf(dir: string, signals: Signal[]): string | undefined {
  const s = signals.find((x) => x.ev);
  if (!s?.ev) return undefined;
  const r = `${s.says} in ${relTo(dir, s.ev.file)}`;
  return r.length > 200 ? `${r.slice(0, 199)}…` : r;
}

/** Evidence + reason from signals, strongest first. */
export function found(dir: string, signals: Signal[], max = 4): { evidence: Evidence[]; reason?: string } {
  const reason = reasonOf(dir, signals);
  return { evidence: uniqEvidence(signals.map((s) => s.ev), max), ...(reason ? { reason } : {}) };
}

/** A compose service running one of `images` (`postgres:16`, `bitnami/redis`). */
export function imageMatch<T extends { image?: { value: string } }>(services: T[], re: RegExp): T | undefined {
  return services.find((s) => s.image && re.test(s.image.value.replace(/^(docker\.io\/)?(library\/)?/, '')));
}
