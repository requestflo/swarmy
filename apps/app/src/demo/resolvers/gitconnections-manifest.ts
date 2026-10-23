/**
 * The GitHub App manifest in the demo — the same shape `buildGithubManifest`
 * (packages/trpc/src/services/git-providers/github-app.ts) makes for a
 * controller at https://swarmy.northwind.dev, so the wizard's preview reads
 * exactly as it would against a real controller.
 */
const CONTROLLER = 'https://swarmy.northwind.dev';

/** `defaultAppName(CONTROLLER)`: "swarmy-" + the hostname with dots as dashes. */
export const DEMO_APP_NAME = 'swarmy-swarmy-northwind-dev';

export function demoManifest(): string {
  return JSON.stringify({
    name: DEMO_APP_NAME,
    url: CONTROLLER,
    hook_attributes: { url: `${CONTROLLER}/webhooks/github`, active: true },
    redirect_url: `${CONTROLLER}/git/github/manifest/callback`,
    callback_urls: [`${CONTROLLER}/git/github/setup`],
    request_oauth_on_install: true,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: 'read', metadata: 'read', checks: 'write', statuses: 'write', pull_requests: 'write' },
    default_events: ['push', 'pull_request', 'installation', 'installation_repositories'],
  });
}

/**
 * The dashboard reads the manifest first (the preview), then mints a fresh one
 * to post when you press Create. A real controller creates nothing either
 * time — GitHub does, then calls back. The demo has no GitHub, so it treats
 * the first call per host + owner as the preview and the next as the post,
 * and registers + installs the app right then.
 */
export function isPreviewCall(seen: string[], webBase: string, org: string | undefined): boolean {
  const key = `${webBase}|${org ?? ''}`;
  if (seen.includes(key)) return false;
  seen.push(key);
  return true;
}
