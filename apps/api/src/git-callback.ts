/**
 * Browser redirect targets for git provider connections (git-apps Phase 2).
 *
 *   GET /git/github/manifest/callback?code&state   — App registered → install it
 *   GET /git/github/setup?code&installation_id&state — installed → bind to the org
 *   GET /git/gitlab/callback?code&state             — GitLab OAuth grant
 *   GET /git/gitea/callback?code&state              — Gitea / Forgejo OAuth grant
 *
 * These run with NO session (the browser is coming back from the provider);
 * authority comes from the signed, expiring `state` minted when the admin
 * started the flow (git-providers/state.ts) PLUS the host-only nonce cookie
 * set in that admin's browser (git-browser-bind.ts) — a state finished in any
 * other browser is refused. The cookie is cleared once a flow ends. On success
 * or failure the browser lands back on the dashboard's CI page with a
 * plain-words result.
 */
import { Hono, type Context } from 'hono';
import { prisma } from '@swarmy/db';
import {
  clearGitBindCookie,
  completeGiteaOAuth,
  completeGithubManifest,
  completeGithubSetup,
  completeGitlabOAuth,
  gitBindCookie,
  gitBindNonce,
} from '@swarmy/trpc';
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

/** The browser nonce this callback carries (null → every state is refused). */
const nonceOf = (c: Context) => gitBindNonce(c.req.header('cookie'));

/** Redirect and end the flow: the nonce cookie is single-use. */
function finish(c: Context, url: string) {
  c.header('set-cookie', clearGitBindCookie(), { append: true });
  return c.redirect(url);
}

gitCallbackApp.get('/github/manifest/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return finish(c, fail('GitHub did not return a registration code.'));
  const browserNonce = nonceOf(c);
  try {
    const { installUrl } = await completeGithubManifest(deps(), { code, state, browserNonce });
    // Straight on to installing it — the operator picks repos on GitHub. The
    // install step is bound to the same browser, so keep (refresh) its cookie.
    if (browserNonce) c.header('set-cookie', gitBindCookie(browserNonce), { append: true });
    return c.redirect(installUrl);
  } catch (e) {
    return finish(c, fail(e));
  }
});

gitCallbackApp.get('/github/setup', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const installationId = c.req.query('installation_id');
  if (!installationId) {
    // `setup_action=request`: an org member asked an owner to approve the install.
    if (c.req.query('setup_action') === 'request')
      return finish(c, dashboard('/ci', { git: 'requested' }));
    return finish(c, fail('GitHub did not return an installation.'));
  }
  if (!code || !state)
    return finish(
      c,
      fail('This install was not started from swarmy — connect GitHub from the CI page.'),
    );
  try {
    const { connectionId } = await completeGithubSetup(deps(), {
      code,
      state,
      installationId,
      browserNonce: nonceOf(c),
    });
    return finish(c, dashboard('/ci', { git: 'connected', kind: 'github', connection: connectionId }));
  } catch (e) {
    return finish(c, fail(e));
  }
});

gitCallbackApp.get('/gitlab/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state)
    return finish(c, fail(c.req.query('error_description') ?? 'GitLab did not authorize swarmy.'));
  try {
    const { connectionId } = await completeGitlabOAuth(deps(), { code, state, browserNonce: nonceOf(c) });
    return finish(c, dashboard('/ci', { git: 'connected', kind: 'gitlab', connection: connectionId }));
  } catch (e) {
    return finish(c, fail(e));
  }
});

gitCallbackApp.get('/gitea/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state)
    return finish(
      c,
      fail(c.req.query('error_description') ?? 'Gitea / Forgejo did not authorize swarmy.'),
    );
  try {
    const { connectionId } = await completeGiteaOAuth(deps(), { code, state, browserNonce: nonceOf(c) });
    return finish(c, dashboard('/ci', { git: 'connected', kind: 'gitea', connection: connectionId }));
  } catch (e) {
    return finish(c, fail(e));
  }
});
