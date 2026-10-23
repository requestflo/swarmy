import type { DbBackupScheduleView } from '@swarmy/core';

/**
 * The `swarmy.db.backup.*` labels on the cluster primary, rendered the way
 * the service writes them (`encodeScheduleLabel`: stable field order, optional
 * fields only when set). With `retentionDays` it shows what saving the new
 * keep window would write.
 */
export function renderedDbLabels(
  s: DbBackupScheduleView | null,
  primary: string,
  retentionDays?: number,
): string {
  const head = `# service ${primary} (live labels)`;
  if (!s) return `${head}\n# no swarmy.db.backup.schedule label: no recurring backup`;
  const schedule = JSON.stringify({
    cron: s.cron,
    engine: s.engine,
    retentionDays: retentionDays ?? s.retentionDays,
    pitr: s.pitr,
    ...(s.targetId ? { targetId: s.targetId } : {}),
    ...(s.dataVolume ? { dataVolume: s.dataVolume } : {}),
    // Saving from the dashboard makes it a user's schedule, so `auto` drops.
    ...(s.auto && retentionDays === undefined ? { auto: true } : {}),
  });
  const lines = [head, `swarmy.db.backup.schedule=${schedule}`];
  if (s.pitr) lines.push('swarmy.db.backup.pitr=true');
  lines.push(
    s.lastRunAt
      ? `# swarmy.db.backup.lastRun: stamped after every run (last ${s.lastRunAt}, ${s.lastStatus ?? 'unknown'})`
      : '# swarmy.db.backup.lastRun: stamped after the first run',
  );
  return lines.join('\n');
}

/** `<stack>_<cluster>-primary`, the service the labels live on. */
export function primaryService(stack: string, cluster: string): string {
  return `${stack}_${cluster}-primary`;
}
