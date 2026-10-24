import { ENV_NAME_RE, RESERVED_ENV_NAMES } from '@swarmy/app-config';
import type { AppEnvironment, GitApp, SecretSlot } from '../gitops-types';

/**
 * Clone as a new environment (board Environments), the words and checks the
 * sheet shows before anything runs. PURE — unit-tested. The controller
 * checks the same things again (and whether swarmy.yaml already names it).
 */

/** The first free of qa, qa-2, qa-3… */
export function suggestName(app: GitApp, base = 'qa'): string {
  const taken = new Set(app.environments.map((e) => e.environment));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function nameProblem(app: GitApp, name: string): string | null {
  if (!name) return 'Give it a name';
  if (!ENV_NAME_RE.test(name)) return 'Lowercase letters, digits and -, up to 20, starting with a letter';
  if ((RESERVED_ENV_NAMES as readonly string[]).includes(name)) return `“${name}” is reserved`;
  if (app.environments.some((e) => e.environment === name)) return `${app.appName ?? 'This app'} already has ${name}`;
  return null;
}

export interface MaskOption {
  available: boolean;
  hint: string;
}

/** The mask step is the app's `previews.data.scrub` SQL (production's swarmy.yaml). */
export function maskOption(app: GitApp): MaskOption {
  const scrub = app.previewRules?.data?.scrub;
  return scrub
    ? { available: true, hint: `runs ${scrub} on the copy before anything connects` }
    : { available: false, hint: 'no mask step yet — add previews.data.scrub (a .sql file) to swarmy.yaml' };
}

export type DbChoice = 'empty' | 'copy';

export function dbOptions(from: string): Array<{ value: DbChoice; label: string }> {
  return [
    { value: 'empty', label: 'Empty' },
    { value: 'copy', label: `Copy of ${from}’s newest backup` },
  ];
}

/** What the clone makes, in plain words (the sheet's preview list). */
export function cloneSteps(app: GitApp, from: AppEnvironment, name: string, branch: string, db: DbChoice, mask: boolean): Array<[string, string]> {
  const stack = `${app.appName ?? from.stack}-${name || '…'}`;
  return [
    [`Build ${branch || '…'}`, `${app.configPath} · same build as a push`],
    [`Its own copy of ${app.appName ?? 'the app'}`, `stack ${stack} · same swarmy.yaml as ${from.environment}, none of its domains`],
    ['Database', db === 'copy' ? `a copy of ${from.environment}’s newest backup${mask ? ', masked' : ''}` : 'starts empty'],
    ['Secrets', 'none copied — each starts empty for you to fill, write-only'],
    ['Kept', 'long-lived — not a preview, it never expires'],
  ];
}

export function slotsLeft(slots: readonly SecretSlot[] | undefined): number {
  return (slots ?? []).filter((s) => !s.filled).length;
}

/** "api reads /run/secrets/stripe-key · web reads $STRIPE_KEY". */
export function slotReaders(slot: SecretSlot): string {
  return slot.consumers.map((c) => (c.envName ? `${c.service} reads $${c.envName}` : `${c.service} reads /run/secrets/${slot.family}`)).join(' · ');
}
