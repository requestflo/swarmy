import type { EnvDiff } from '@swarmy/core';
import { curl, type CodeTab } from '@/components/calm';

/** The same change from a terminal (`swarmy env push`) or over REST (PATCH /services/{id}/env). Values never printed. */
export function pasteCode(stack: string, short: string, serviceId: string, diff: EnvDiff, secret: ReadonlySet<string>, replace: boolean): CodeTab[] {
  const moving = diff.rows.filter((r) => r.kind === 'added' || r.kind === 'changed');
  const secrets = moving.filter((r) => secret.has(r.key)).map((r) => r.key);
  const cli = [
    '# save the paste as .env, then:',
    `swarmy env push .env --app ${stack} --service ${short}${secrets.map((k) => ` --secret ${k}`).join('')}${replace ? ' --prune' : ''}`,
  ].join('\n');
  const set = Object.fromEntries(moving.filter((r) => !secret.has(r.key)).map((r) => [r.key, '…']));
  const body = {
    ...(Object.keys(set).length ? { set } : {}),
    ...(secrets.length ? { secrets: Object.fromEntries(secrets.map((k) => [k, '…'])) } : {}),
    ...(replace ? { unset: diff.rows.filter((r) => r.kind === 'removed').map((r) => r.key) } : {}),
  };
  return [
    { label: 'CLI', code: cli },
    { label: 'REST', code: curl('PATCH', `/services/${serviceId}/env`, body) },
  ];
}
