/**
 * Plain words for backup rows at Summary. The raw volume name and the agent's
 * error stay as the Tech line at Controls.
 */

/** "storefront_checkout" → "storefront’s checkout data"; "data_postgres-data" → "data’s postgres data". */
export function volumeWords(volume: string): string {
  const i = volume.indexOf('_');
  if (i <= 0) return `${volume.replace(/[-_]data$/, '')} data`;
  const app = volume.slice(0, i);
  const part = volume.slice(i + 1).replace(/[-_]data$/, '').replace(/[-_]/g, ' ');
  return `${app}’s ${part || 'app'} data`;
}

const REASONS: [RegExp, string][] = [
  [/lock/i, 'another save was still running'],
  [/no space|ENOSPC|disk full|quota/i, 'the disk where it saves is full'],
  [/credential|access denied|forbidden|\b403\b|signature|unauthori[sz]ed|\b401\b/i, 'the destination refused swarmy’s key'],
  [/timeout|timed out|ETIMEDOUT|unreachable|ECONNREFUSED|connection refused|no route/i, 'swarmy couldn’t reach where backups go'],
  [/no such|not found|does not exist/i, 'what it saves wasn’t there'],
];

/** "Couldn’t save: another save was still running. It’ll retry on the next nightly run." */
export function failureWords(error: string | null | undefined): string {
  const hit = REASONS.find(([re]) => re.test(error ?? ''));
  return hit
    ? `Couldn’t save: ${hit[1]}. It’ll retry on the next nightly run.`
    : 'Couldn’t save. It’ll retry on the next nightly run; the reason is at Controls.';
}
