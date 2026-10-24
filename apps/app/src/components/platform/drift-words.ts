/**
 * Plain words for Settings › Platform → "Not on the release" (the drift rows
 * from `platform.drift`, platform-drift.ts). Pure, so the section and its
 * tests agree. Summary words only: "build", "version", "copy" — never digest,
 * replica or node; the exact images go on the Controls tech line.
 */

export interface DriftRowLite {
  service: string;
  key: string;
  owner: 'system' | 'controller' | 'engine';
  running: string;
  expected: string | null;
  kind: 'digest' | 'floating' | 'tag';
  action: 'repin' | 'explain';
}

const COUNT = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

/** "Two of swarmy's own services aren't on 1.3.0." */
export function driftHeadline(n: number, version: string): string {
  const count = COUNT[n] ?? String(n);
  return n === 1 ? `One of swarmy's own services isn't on ${version}.` : `${count} of swarmy's own services aren't on ${version}.`;
}

/** The row's one sentence. */
export function driftSay(row: DriftRowLite, version: string): string {
  if (row.owner === 'controller') return `On another build than ${version} names.`;
  if (row.owner === 'engine') return `Object storage is on another build than ${version} names.`;
  if (row.kind === 'floating') return 'Runs a floating tag, so a restart could pull another build.';
  if (row.kind === 'tag') return `Runs another version than ${version} names.`;
  return `Runs another build than ${version} names.`;
}

/** Why swarmy doesn't re-pin an explain row from here. */
export function driftWhy(row: DriftRowLite, version: string): string {
  if (row.owner === 'controller') {
    return `The controller only moves during an upgrade: it restarts itself on the new build and carries the upgrade on. Start one here, or re-run the installer, to put it back on ${version}.`;
  }
  if (row.owner === 'engine') {
    return 'Object storage moves during an upgrade, one copy at a time with the store kept healthy, so swarmy never restarts it on its own.';
  }
  return `${version} doesn't name an exact build for it (a development release), so there is nothing to pin it to. Upgrading to a tagged release settles it.`;
}

/** What Re-pin does, for its tooltip and the toast. */
export const REPIN_WHAT = "Restarts it on the release's image, one copy at a time; Swarm puts the old one back if it doesn't come up healthy.";

/** The Controls tech line: running → expected. */
export function driftTech(row: DriftRowLite): string {
  return `${row.running} → ${row.expected ?? 'no exact build named'}`;
}
