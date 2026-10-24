import type { AppEnvironment } from '../gitops-types';
import { envLabel } from '../plan-status';

/**
 * Remove a cloned environment (board Environments), the words the confirm
 * shows before anything runs and the receipt after. PURE — unit-tested. The
 * controller refuses production and the environments swarmy.yaml names.
 */

export type RemoveDbChoice = 'keep' | 'delete';

export const REMOVE_DB_OPTIONS: Array<{ value: RemoveDbChoice; label: string }> = [
  { value: 'keep', label: 'Keep its database' },
  { value: 'delete', label: 'Delete its database' },
];

/** What removing it does, in plain words with the tech line under each. */
export function removeEnvSteps(env: AppEnvironment, db: RemoveDbChoice): Array<[string, string]> {
  const name = envLabel(env.environment);
  const slots = env.dashboard?.secretSlots ?? [];
  return [
    [`${name}’s services stop and go`, `every app service in ${env.stack} · its jobs and private links · its caches and buckets`],
    db === 'keep'
      ? ['Its database stays, with its backups', `still running in ${env.stack} — remove it from Data when you’re done`]
      : ['Its database is deleted, with everything in it', 'from every server — this can’t be undone'],
    slots.length
      ? [slots.length === 1 ? 'Its own secret is deleted' : 'Its own secrets are deleted', `${slots.map((s) => s.envFamily).join(', ')} · shared secrets aren’t touched`]
      : ['No secrets of its own to delete', 'shared secrets aren’t touched'],
    [`Pushes to ${env.branch || 'its branch'} stop deploying it`, `the marker is dropped · the name ${env.environment} is free again`],
  ];
}

export interface RemovedEnv {
  environment: string;
  databases: { kept: string[]; deleted: string[] };
  secrets: { removed: string[]; kept: string[] };
}

/** The receipt toast: "QA is gone. Its database keeps running — remove it from Data when you're done." */
export function removedWords(r: RemovedEnv): string {
  const name = envLabel(r.environment);
  const db = r.databases.kept.length
    ? ` Its database keeps running — remove it from Data when you’re done.`
    : r.databases.deleted.length
      ? ' Its database is deleted.'
      : '';
  const secrets = r.secrets.kept.length ? ` ${r.secrets.kept.join(', ')} stays: another app still reads it.` : '';
  return `${name} is gone.${db}${secrets}`;
}
