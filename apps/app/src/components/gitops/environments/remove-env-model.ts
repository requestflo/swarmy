import type { AppEnvironment } from '../gitops-types';
import { envLabel } from '../plan-status';

/**
 * Remove a cloned environment (board Environments), the words the confirm
 * shows before anything runs and the receipt after. PURE — unit-tested. The
 * controller plans the same thing (apps/remove-env-plan.ts) and refuses
 * production and the environments swarmy.yaml names.
 */

export type RemoveDataChoice = 'keep' | 'delete';

export const REMOVE_DATA_OPTIONS: Array<{ value: RemoveDataChoice; label: string }> = [
  { value: 'keep', label: 'Keep its data' },
  { value: 'delete', label: 'Delete its data' },
];

const list = (xs: readonly string[], max = 3): string =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`;

const addressStep = (stack: string, hosts: readonly string[]): [string, string] =>
  hosts.length
    ? [hosts.length === 1 ? 'Its address stops answering' : 'Its addresses stop answering', list(hosts)]
    : ['It has no addresses to take down', `nothing routes to ${stack}`];

/**
 * What removing it does, in plain words with the tech line under each.
 * `hosts` = its addresses right now (undefined while they load: no line).
 */
export function removeEnvSteps(env: AppEnvironment, data: RemoveDataChoice, hosts?: readonly string[]): Array<[string, string]> {
  const name = envLabel(env.environment);
  const slots = env.dashboard?.secretSlots ?? [];
  return [
    [`${name}’s services stop and go`, `every app service in ${env.stack} · its jobs and private links · its caches and buckets`],
    ...(hosts ? [addressStep(env.stack, hosts)] : []),
    data === 'keep'
      ? ['Its data stays, with its backups', `its database keeps running in ${env.stack} · its volumes stay on the servers, marked left over`]
      : ['Its data is deleted, with everything in it', 'its database and volumes, from every server — this can’t be undone'],
    slots.length
      ? [slots.length === 1 ? 'Its own secret is deleted' : 'Its own secrets are deleted', `${slots.map((s) => s.envFamily).join(', ')} · shared secrets aren’t touched`]
      : ['No secrets of its own to delete', 'shared secrets aren’t touched'],
    [`Pushes to ${env.branch || 'its branch'} stop deploying it`, `the marker is dropped · the name ${env.environment} is free again`],
  ];
}

export interface RemovedEnv {
  environment: string;
  databases: { kept: string[]; deleted: string[] };
  /** Older controllers don't report volumes. */
  volumes?: { kept: string[]; deleted: string[] };
  secrets: { removed: string[]; kept: string[] };
}

/** The receipt toast: "QA is gone. Its database keeps running — remove it from Data when you're done." */
export function removedWords(r: RemovedEnv): string {
  const name = envLabel(r.environment);
  const keptVolumes = r.volumes?.kept.length ?? 0;
  const db = r.databases.kept.length
    ? ' Its database keeps running — remove it from Data when you’re done.'
    : r.databases.deleted.length || r.volumes?.deleted.length
      ? ' Its data is deleted.'
      : '';
  const vols = keptVolumes ? ` ${keptVolumes === 1 ? 'One volume stays' : `${keptVolumes} volumes stay`} on the servers, marked left over.` : '';
  const secrets = r.secrets.kept.length ? ` ${r.secrets.kept.join(', ')} stays: another app still reads it.` : '';
  return `${name} is gone.${db}${vols}${secrets}`;
}
