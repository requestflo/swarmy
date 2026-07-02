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
import { prisma, type DB } from '@swarmy/db';
import { triggerBuildForRepo, type AgentHub } from '@swarmy/trpc';
import { authRegistry, type Auth } from '@swarmy/auth';
import { hub } from './gateway';
import {
  parseCommitSha,
  parsePushRef,
  verifyWebhookSignature,
  type WebhookProvider,
} from './webhook-verify';

export const webhooksApp = new Hono();

// ── D4: PR preview environments ───────────────────────────────────────────────
// PR / MR events on the SAME per-repo endpoint (same HMAC/token verification)
// drive ephemeral preview stacks via `previews.service.handlePrEvent`.
//
// ORCHESTRATOR TODO (spine seam missing): add to packages/trpc/src/index.ts
//   export { handlePrEventForRepo, parsePrWebhookEvent } from './services/previews.service';
//   export type { PrEventResult, PrWebhookEvent } from './services/previews.service';
// …then replace this dynamic seam (and its signature mirror below) with a
// static root import. Until then the canonical implementation is loaded by
// file URL — Bun resolves the workspace package by realpath, so module
// identity (build-log bus, etc.) is SHARED with the '@swarmy/trpc' graph; a
// static relative import is not an option (TS6059 outside this app's rootDir).

/** Signature mirror of previews.service.ts exports — keep in sync (D4). */
interface PreviewsSeam {
  parsePrWebhookEvent(
    provider: WebhookProvider,
    eventHeader: string | null | undefined,
    body: unknown,
  ): { action: 'opened' | 'synchronize' | 'closed'; prNumber: number; branch: string; commit: string | null } | null;
  handlePrEventForRepo(
    deps: { db: DB; hub: AgentHub; auth: Auth },
    input: {
      repoId: string;
      orgId: string;
      action: 'opened' | 'synchronize' | 'closed';
      prNumber: number;
      branch: string;
      commit?: string | null;
    },
  ): Promise<{ action: 'deployed' | 'torn-down' | 'skipped'; stack?: string; url?: string | null; reason?: string }>;
}

let previewsSeamPromise: Promise<PreviewsSeam> | null = null;

/** Lazily load the previews service (memoized; see ORCHESTRATOR TODO above). */
function previewsSeam(): Promise<PreviewsSeam> {
  previewsSeamPromise ??= import(
    new URL('../../../packages/trpc/src/services/previews.service.ts', import.meta.url).href
  ) as Promise<PreviewsSeam>;
  return previewsSeamPromise;
}

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

  // D4: PR preview environments — a verified pull-request / merge-request event
  // (opened/synchronize → build the branch + deploy `pr<N>-<repo-short>`;
  // closed → teardown) is handled here; anything else falls through to the
  // existing push handling below.
  const previews = await previewsSeam().catch(() => null);
  const prEvent = previews?.parsePrWebhookEvent(provider, event ?? null, body) ?? null;
  if (previews && prEvent) {
    const result = await previews
      .handlePrEventForRepo(
        { db: prisma, hub, auth: authRegistry.getAuth() },
        { ...prEvent, repoId: repo.id, orgId: repo.orgId },
      )
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }) as const);
    if ('error' in result) return c.json({ error: result.error }, 502);
    return c.json({ ok: true, pr: prEvent.prNumber, ...result });
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
