/**
 * Canned compliance questions as saved filters — each is an OR-of-action-prefixes
 * the service turns into `startsWith` matches. Client-side only: picking one
 * just fills the filter state.
 */
export interface CannedQuestion {
  key: string;
  label: string;
  /** One-line answer to "what does this show?". */
  hint: string;
  /** Action prefixes OR-ed together server-side. */
  actions: string[];
}

export const CANNED_QUESTIONS: CannedQuestion[] = [
  {
    key: 'prod-access',
    label: 'Who accessed production?',
    hint: 'Container terminals and node shell sessions',
    actions: ['terminal.'],
  },
  {
    key: 'secret-changes',
    label: 'Who changed secrets?',
    hint: 'Secrets created, rotated, attached or deleted',
    actions: ['secrets.', 'secret.'],
  },
  {
    key: 'deploys',
    label: 'Who deployed?',
    hint: 'Stack/service deploys, CI autodeploys, rollbacks',
    actions: [
      'stack.deploy',
      'service.builder.deploy',
      'service.deploy',
      'templates.deploy',
      'cicd.autodeploy',
      'release.',
    ],
  },
  {
    key: 'policy-changes',
    label: 'Policy changes',
    hint: 'Access policies, guardrails, exposure and terminal policies',
    actions: ['policy.', 'guardrails.', 'exposure.rules', 'terminal.policy'],
  },
  {
    key: 'backups',
    label: 'Backup & restore activity',
    hint: 'Volume, database, cache and controller backups/restores',
    actions: ['backup.', 'db.backup', 'db.restore', 'controller.backup.', 'cache.backup', 'cache.restore'],
  },
];
