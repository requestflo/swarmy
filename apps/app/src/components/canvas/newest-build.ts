import type { Tone } from '@/components/calm';
import { shortOf } from '@/components/connections/connections-model';

/** One stage of the newest build, as a chip: "build ✓ 38 s", "scan clean", "running on api". */
export interface BuildChip {
  label: string;
  tone: Tone;
}

export interface NewestBuild {
  id: string;
  /** The part the build's repo deploys to. */
  part: string;
  chips: BuildChip[];
  /** Controls line: commit and image. */
  tech: string;
}

interface BuildLike {
  id: string;
  repoId: string;
  status: string;
  image: string | null;
  commit: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Timed stages (newer controllers); the build stage's own time beats start → finish. */
  stages?: ReadonlyArray<{ key: string; startedAt: string; finishedAt: string | null; outcome: string }>;
}

interface ScanLike {
  digest: string | null;
  status: string;
  criticalCount: number;
  highCount: number;
}

export function seconds(s: number): string {
  return s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`;
}

function scanChip(s: ScanLike): BuildChip {
  if (s.status === 'error') return { label: 'scan couldn’t finish', tone: 'bad' };
  if (s.criticalCount > 0) return { label: `${s.criticalCount} critical`, tone: 'bad' };
  if (s.highCount > 0) return { label: `${s.highCount} high`, tone: 'warn' };
  return { label: 'scan clean', tone: 'ok' };
}

/**
 * The newest build of any repo that deploys to one of this app's parts
 * (`cicd.listRepos` serviceId), with only the stages swarmy records: the
 * build and its time, the CVE scan of that exact digest, and whether a part
 * runs that digest now, plus "signed" once the build's sign stage passed. No row, no chip.
 */
export function newestBuild(
  stack: string,
  services: ReadonlyArray<{ id: string; name: string; image: string }>,
  repos: ReadonlyArray<{ id: string; serviceId: string | null }>,
  builds: readonly BuildLike[],
  scans: readonly ScanLike[],
  now = Date.now(),
): NewestBuild | null {
  const repoPart = new Map<string, string>();
  for (const r of repos) {
    const s = services.find((x) => x.id === r.serviceId);
    if (s) repoPart.set(r.id, shortOf(stack, s.name));
  }
  const b = builds
    .filter((x) => repoPart.has(x.repoId) && x.startedAt)
    .sort((a, z) => Date.parse(z.startedAt!) - Date.parse(a.startedAt!))[0];
  if (!b) return null;
  const stage = (key: string) => b.stages?.find((s) => s.key === key);
  const timed = stage('build');
  const started = Date.parse(timed?.startedAt ?? b.startedAt!);
  const ended = timed ? timed.finishedAt : b.finishedAt;
  const took = ((ended ? Date.parse(ended) : now) - started) / 1000;
  const chips: BuildChip[] = [
    b.status === 'succeeded'
      ? { label: `build ✓ ${seconds(took)}`, tone: 'ok' }
      : b.status === 'failed'
        ? { label: 'build failed', tone: 'bad' }
        : { label: `building… ${seconds(took)}`, tone: 'info' },
  ];
  const at = b.image?.indexOf('@sha256:') ?? -1;
  const digest = b.image && at >= 0 ? b.image.slice(at + 1) : null;
  if (b.status === 'succeeded' && digest) {
    const scan = scans.find((s) => s.digest === digest);
    if (scan) chips.push(scanChip(scan));
    if (stage('sign')?.outcome === 'ok') chips.push({ label: 'signed', tone: 'ok' });
    const runs = services.find((s) => s.image.includes(digest));
    if (runs) chips.push({ label: `running on ${shortOf(stack, runs.name)}`, tone: 'ok' });
  }
  return { id: b.id, part: repoPart.get(b.repoId)!, chips, tech: [b.commit?.slice(0, 7), b.image].filter(Boolean).join(' · ') };
}
