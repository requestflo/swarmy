/**
 * The wizard's "What we found · live" list (board 23) — PURE. Each thing the
 * picked folder's code needs: what it is, why we think so (the scan's plain
 * words, or its first file:line), and what the drafted swarmy.yaml adds for
 * it — a managed service, connected to the app by the env var it reads.
 */
import type { Detection } from './git-scan-types';

export interface FoundNeed {
  id: string;
  /** "Postgres" · "Job queue (bullmq)". */
  kind: string;
  /** "uses Prisma with PostgreSQL in prisma/schema.prisma". */
  why: string;
  /** "Adds a managed Postgres, connected as DATABASE_URL". */
  adds: string;
  /** The swarmy.yaml key (Controls depth). */
  maps: string;
}

const as = (d: Detection, fallback: string): string => `connected as ${(d.env?.length ? d.env : [fallback]).slice(0, 2).join(' + ')}`;

function addsFor(d: Detection): string {
  switch (d.kind) {
    case 'postgres':
      return `Adds a managed Postgres, backed up nightly, ${as(d, 'DATABASE_URL')}`;
    case 'cache':
      return `Adds a managed Valkey cache, ${as(d, 'REDIS_URL')}`;
    case 'queue':
      return `Adds a managed queue that never drops a job, ${as(d, 'REDIS_URL')}`;
    case 'bucket':
      return `Adds a private bucket, ${as(d, 'S3_BUCKET')}; keys arrive at deploy`;
    case 'worker':
      return `Adds ${d.name}, a background copy of the same build`;
    case 'cron':
      if (d.via === 'in-process') return `Keeps ${d.host ?? 'web'} at one copy, so it fires once`;
      if (d.via === 'clock') return `Adds ${d.name} as one always-on copy`;
      return `Adds a scheduled job${d.schedule ? ` at "${d.schedule}"` : ''}`;
    default:
      return '';
  }
}

/** Every detection but the web service (always there), in scan order. */
export function foundNeeds(detections: Detection[]): FoundNeed[] {
  return detections
    .filter((d) => d.kind !== 'web')
    .map((d) => {
      const e = d.evidence[0];
      return {
        id: d.id,
        kind: d.via === 'in-process' || d.kind !== 'cron' ? d.label : `${d.label}: ${d.name}`,
        why: d.reason ?? (e ? `${e.file}:${e.line} ${e.text}` : 'found in the code'),
        adds: addsFor(d),
        maps: d.maps,
      };
    });
}

/** "4 things its code needs" · "Nothing else its code needs". */
export function needsHead(n: number): string {
  return n === 0 ? 'Nothing else its code needs' : `${n} thing${n === 1 ? '' : 's'} its code needs`;
}
