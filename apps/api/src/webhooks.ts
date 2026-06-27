/**
 * Git webhook receiver (epic: git-cicd-registry, PHASE-2).
 *
 * `POST /webhooks/git/:repoId` — GitHub/GitLab push handler. The controller is
 * the only public surface in a swarmy install, so this is where a `git push`
 * becomes a build:
 *
 *   1. Look up the `GitRepo` by id (the per-repo URL pasted into the provider).
 *   2. Verify the provider signature against the repo's stored webhook secret
 *      (GitHub: HMAC-SHA256 `X-Hub-Signature-256`; GitLab: constant-time token
 *      compare of `X-Gitlab-Token`). The secret is decrypted JIT via the shared
 *      `@swarmy/core/crypto` vault — never logged, never returned.
 *   3. Filter to push events on the repo's watched branch.
 *   4. Trigger a build as a SYSTEM principal (audited `actorType: system`),
 *      which — if the repo has autodeploy + a linked service — redeploys it.
 *
 * Signature verification is a pure, exported function so it is unit-tested in
 * isolation (see INTEGRATION test snippets). The route is registered in
 * apps/api/src/index.ts (snippet returned in INTEGRATION).
 */
import { Hono } from 'hono';
import { decryptSecret } from '@swarmy/core/crypto';
import { prisma } from '@swarmy/db';
import { triggerBuildForRepo } from '@swarmy/trpc';
import { authRegistry } from '@swarmy/auth';
import { hub } from './gateway';
import {
  parseCommitSha,
  parsePushRef,
  verifyWebhookSignature,
  type WebhookProvider,
} from './webhook-verify';

export const webhooksApp = new Hono();

webhooksApp.post('/git/:repoId', async (c) => {
  const repoId = c.req.param('repoId');
  const rawBody = await c.req.text();

  const repo = await prisma.gitRepo.findUnique({
    where: { id: repoId },
    select: { id: true, orgId: true, branch: true, provider: true, webhookSecretEnc: true },
  });
  if (!repo) return c.json({ error: 'unknown repo' }, 404);
  if (!repo.webhookSecretEnc) return c.json({ error: 'webhook not configured' }, 400);

  const provider: WebhookProvider = repo.provider === 'GITLAB' ? 'gitlab' : 'github';
  const secret = decryptSecret(repo.webhookSecretEnc);

  const ok = verifyWebhookSignature({
    provider,
    secret,
    rawBody,
    githubSignature: c.req.header('x-hub-signature-256'),
    gitlabToken: c.req.header('x-gitlab-token'),
  });
  if (!ok) return c.json({ error: 'invalid signature' }, 401);

  // Only react to push events; ignore pings / other event types.
  const event = c.req.header('x-github-event') ?? c.req.header('x-gitlab-event');
  if (event && /ping/i.test(event)) return c.json({ ok: true, ignored: 'ping' });

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'malformed body' }, 400);
  }

  const ref = parsePushRef(provider, body);
  // Only build the watched branch (defensive — providers can be configured broadly).
  if (ref && repo.branch && ref !== repo.branch) {
    return c.json({ ok: true, ignored: 'branch', ref });
  }

  const build = await triggerBuildForRepo(
    { db: prisma, hub, auth: authRegistry.getAuth() },
    { repoId: repo.id, orgId: repo.orgId, ref: ref ?? repo.branch, commit: parseCommitSha(provider, body) },
  ).catch((e: unknown) => {
    return { error: e instanceof Error ? e.message : String(e) } as const;
  });

  if ('error' in build) return c.json({ error: build.error }, 502);
  return c.json({ ok: true, buildId: build.id, ref: ref ?? repo.branch });
});
