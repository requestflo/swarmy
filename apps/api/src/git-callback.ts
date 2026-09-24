/**
 * Browser redirect targets for git provider connections (git-apps Phase 2).
 *
 *   GET /git/github/manifest/callback?code&state   — App registered → install it
 *   GET /git/github/setup?code&installation_id&state — installed → bind to the org
 *   GET /git/gitlab/callback?code&state             — GitLab OAuth grant
 *
 * These run with NO session (the browser is coming back from the provider);
 * authority comes entirely from the signed, expiring `state` minted when the
 * admin started the flow — see git-providers/state.ts. On success or failure
 * the browser lands back on the dashboard's CI page with a plain-words result.
 */
import { Hono } from 'hono';
import { prisma } from '@swarmy/db';
import { completeGithubManifest, completeGithubSetup, completeGitlabOAuth } from '@swarmy/trpc';
import { authRegistry } from '@swarmy/auth';
import { hub } from './gateway';

export const gitCallbackApp = new Hono();

const deps = () => ({ db: prisma, hub, auth: authRegistry.getAuth() });

/** Where the dashboard lives (same-origin in the single image; Vite in dev). */
function dashboard(path: string, params: Record<string, string>): string {
  const base = (process.env.DASHBOARD_URL ?? '').replace(/\/+$/, '');
  return `${base}${path}?${new URLSearchParams(params).toString()}`;
}

const fail = (e: unknown) =>
  dashboard('/ci', {
    git: 'error',
    message: (e instanceof Error ? e.message : String(e)).slice(0, 200),
  });

gitCallbackApp.get('/github/manifest/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.redirect(fail('GitHub did not return a registration code.'));
  try {
    const { installUrl } = await completeGithubManifest(deps(), { code, state });
    // Straight on to installing it — the operator picks repos on GitHub.
    return c.redirect(installUrl);
  } catch (e) {
    return c.redirect(fail(e));
  }
});

gitCallbackApp.get('/github/setup', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const installationId = c.req.query('installation_id');
  if (!installationId) {
    // `setup_action=request`: an org member asked an owner to approve the install.
    if (c.req.query('setup_action') === 'request')
      return c.redirect(dashboard('/ci', { git: 'requested' }));
    return c.redirect(fail('GitHub did not return an installation.'));
  }
  if (!code || !state)
    return c.redirect(
      fail('This install was not started from swarmy — connect GitHub from the CI page.'),
    );
  try {
    const { connectionId } = await completeGithubSetup(deps(), { code, state, installationId });
    return c.redirect(
      dashboard('/ci', { git: 'connected', kind: 'github', connection: connectionId }),
    );
  } catch (e) {
    return c.redirect(fail(e));
  }
});

gitCallbackApp.get('/gitlab/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state)
    return c.redirect(fail(c.req.query('error_description') ?? 'GitLab did not authorize swarmy.'));
  try {
    const { connectionId } = await completeGitlabOAuth(deps(), { code, state });
    return c.redirect(
      dashboard('/ci', { git: 'connected', kind: 'gitlab', connection: connectionId }),
    );
  } catch (e) {
    return c.redirect(fail(e));
  }
});
