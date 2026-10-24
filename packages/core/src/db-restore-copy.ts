/**
 * "Restore as a copy" creates a NEW managed Postgres beside the original and
 * restores into it. This names it: `<cluster>-restore-<mmdd>` (UTC date),
 * then `-2`, `-3`… while that name is taken. The controller (which creates
 * it) and the dashboard (which shows the name before anything runs) both use
 * this, so the page names exactly the database the restore will create.
 */

/** Longest managed-DB cluster name `db.provision` accepts. */
export const DB_CLUSTER_NAME_MAX = 40;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** PURE: the copy's cluster name, never one of `taken` and never over {@link DB_CLUSTER_NAME_MAX}. */
export function restoreCopyName(cluster: string, at: Date, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const mmdd = `${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}`;
  for (let n = 1; ; n++) {
    const suffix = `-restore-${mmdd}${n > 1 ? `-${n}` : ''}`;
    // A long source name is cut so the copy still fits; never end on a dash.
    const base = cluster.slice(0, DB_CLUSTER_NAME_MAX - suffix.length).replace(/-+$/, '');
    const name = `${base}${suffix}`;
    if (!used.has(name)) return name;
  }
}
