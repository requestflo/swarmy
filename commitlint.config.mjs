/**
 * Conventional Commits — drives semantic-release versioning.
 *   feat:     → minor   |   fix:/perf: → patch   |   BREAKING CHANGE → major
 * Scopes map to workspaces, e.g. feat(app):, fix(agent):, feat(ingress):
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'core',
        'db',
        'auth',
        'ingress',
        'trpc',
        'ui',
        'api',
        'agent',
        'app',
        'web',
        'e2e',
        'deps',
        'ci',
        'release',
        'docs',
        'repo',
      ],
    ],
  },
};
