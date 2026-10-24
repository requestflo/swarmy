/**
 * Plain words for Settings › Platform › Cluster config versions: what each
 * swarm-kv document is, how big it is against its limit, and what putting an
 * older version back would change. Mirrors KV_COLLECTIONS in
 * packages/trpc/src/services/swarm-kv.service.ts.
 */
import { fmtBytes } from '@/components/backups/backup-format';

const WHAT: Record<string, string> = {
  ingress: 'Front door settings',
  mesh: 'Private network settings',
  geodns: 'Geo DNS settings',
  'dns-zone': 'DNS zone',
  obs: 'Observability settings',
  storage: 'Object storage',
  'bkt-acl': 'Bucket access',
  'bkp-target': 'Backup destination',
  'bkp-sched': 'Backup schedule',
  'ctl-backup': 'swarmy’s own backup',
  registry: 'Registry policy',
  'image-gc': 'Image clean-up',
  stack: 'App',
  rum: 'Session replay store key',
  'build-logs': 'Build log store key',
};

/** "Backup destination “offsite”", or the bare kind for a per-org document. */
export function docLabel(collection: string, name: string | null): string {
  const what = WHAT[collection] ?? collection;
  return name ? `${what} “${name}”` : what;
}

/** The Docker config name of a version (the tech line). */
export function configName(collection: string, id: string, seq: number): string {
  return `swarmy-kv.${collection}.${id}.v${seq}`;
}

/** "2.1 KB of 64 KB". */
export function sizeWords(bytes: number, max: number): string {
  return `${fmtBytes(bytes)} of ${fmtBytes(max)}`;
}

/** What a put-back changes, in one clause. */
export function changeWords(changes: readonly string[]): string {
  if (changes.length === 0) return 'Same settings as now';
  if (changes.length <= 3) return `Changes ${changes.join(', ')}`;
  return `Changes ${changes.slice(0, 3).join(', ')} and ${changes.length - 3} more`;
}

/** The section's headline count: "4 documents · 12 versions kept". */
export function countWords(docs: ReadonlyArray<{ versions: readonly unknown[] }>): string {
  const versions = docs.reduce((n, d) => n + d.versions.length, 0);
  return `${docs.length} document${docs.length === 1 ? '' : 's'} · ${versions} version${versions === 1 ? '' : 's'} kept`;
}
