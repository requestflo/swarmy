import type { InviteAbilityKey, InviteVerdict } from '@swarmy/abac/model';

/** One line of the invite preview; `policy` names the forbid rule that blocks it. */
export interface PreviewLine {
  key: string;
  text: string;
  policy?: string;
}

const PHRASE: Record<InviteAbilityKey, (where: string | null) => string> = {
  deploy: (w) => (w ? `deploy ${w}` : 'deploy'),
  restart: (w) => (w ? `restart ${w}` : 'restart'),
  logs: (w) => (w ? `see logs on ${w}` : 'see logs'),
  shell: (w) => (w ? `open a shell on ${w}` : 'open a shell'),
  domains: (w) => (w ? `change domains on ${w}` : 'change domains'),
  people: () => 'manage people',
  data: () => 'delete data',
};

/** "storefront", "storefront and blog", "a, b, c and 2 more". */
export function appList(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/**
 * The verdicts as "They can" / "They can't" lines. An ability allowed on some
 * apps reads on both sides ("deploy storefront" / "deploy payments").
 * `appCount` 0 means the org has no apps yet (judged on a brand-new one).
 */
export function previewLines(verdicts: InviteVerdict[], appCount: number): { can: PreviewLine[]; cant: PreviewLine[] } {
  const can: PreviewLine[] = [];
  const cant: PreviewLine[] = [];
  for (const v of verdicts) {
    const say = PHRASE[v.key];
    const policy = v.blockedBy?.name;
    const app = v.on !== 'org';
    if (v.reach === 'all') {
      can.push({ key: v.key, text: say(app ? (appCount > 0 ? 'every app' : 'new apps') : null) });
    } else if (v.reach === 'some') {
      can.push({ key: v.key, text: say(appList(v.allowedOn)) });
      cant.push({ key: `${v.key}-not`, text: say(appList(v.deniedOn)), ...(policy ? { policy } : {}) });
    } else {
      cant.push({ key: v.key, text: say(null), ...(policy ? { policy } : {}) });
    }
  }
  return { can, cant };
}

/** The deciding rule per ability, for the Controls tech line. */
export function previewTech(verdicts: InviteVerdict[]): string {
  return verdicts.map((v) => `${v.action}=${v.reach}${v.blockedBy ? ` (forbid ${v.blockedBy.id})` : v.permitBy ? ` (${v.permitBy.id})` : ''}`).join(' · ');
}
