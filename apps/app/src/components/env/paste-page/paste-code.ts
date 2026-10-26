import { curl, type CodeTab } from '@/components/calm';
import type { PastePlan } from './paste-target';

/**
 * The same change from a terminal (`swarmy env push`) or over REST (PATCH
 * /services/{id}/env), one call per environment it changes. Values never
 * printed; locked rows (swarmy.yaml declares them) are left out of both.
 */
export function pasteCode(short: string, plans: PastePlan[], secret: ReadonlySet<string>, pasted: ReadonlySet<string>, replace: boolean): CodeTab[] {
  const going = plans.filter((p) => p.moving > 0);
  const shown = going.length ? going : plans.slice(0, 1);
  const cli = ['# save the paste as .env, then:'];
  const rest: string[] = [];
  for (const p of shown) {
    const moving = p.rows.filter((r) => r.kind === 'added' || r.kind === 'changed');
    const secrets = moving.filter((r) => secret.has(r.key)).map((r) => r.key);
    // Replace all keeps what swarmy.yaml declares even when the paste leaves it out; --prune wouldn't.
    const skip = p.rows
      .filter((r) => r.kind === 'locked' || r.kind === 'kept' || (replace && r.kind === 'unchanged' && !pasted.has(r.key)))
      .map((r) => r.key);
    if (skip.length) {
      cli.push(
        replace
          ? `# ${p.environment}: keep ${skip.join(', ')} in the file as they are now — swarmy.yaml sets them, and --prune would remove them`
          : `# ${p.environment}: drop ${skip.join(', ')} from the file first — swarmy.yaml or ${p.environment} sets them`,
      );
    }
    cli.push(`swarmy env push .env --app ${p.stack} --service ${short}${secrets.map((k) => ` --secret ${k}`).join('')}${replace ? ' --prune' : ''}`);
    const set = Object.fromEntries(moving.filter((r) => !secret.has(r.key)).map((r) => [r.key, '…']));
    const body = {
      ...(Object.keys(set).length ? { set } : {}),
      ...(secrets.length ? { secrets: Object.fromEntries(secrets.map((k) => [k, '…'])) } : {}),
      ...(replace ? { unset: p.rows.filter((r) => r.kind === 'removed').map((r) => r.key) } : {}),
    };
    rest.push(curl('PATCH', `/services/${p.serviceId}/env`, body));
  }
  return [
    { label: 'CLI', code: cli.join('\n') },
    { label: 'REST', code: rest.join('\n\n') },
  ];
}
