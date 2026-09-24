/**
 * Git webhook receivers (git-cicd-registry P2 + git-apps P2).
 *
 *   POST /webhooks/github          — the controller's GitHub App (one URL for
 *                                    every installation; HMAC with the App's
 *                                    webhook secret; routed by repository id)
 *   POST /webhooks/git/:repoId     — per-repo hooks: GitLab (X-Gitlab-Token),
 *                                    Gitea (X-Gitea-Signature), generic git
 *                                    (X-Swarmy-Signature), legacy GitHub hooks
 *
 * The controller is the only public surface, so every payload is verified
 * BEFORE it is parsed, deliveries are deduped, and nothing slow runs inside
 * the request: builds and previews are kicked off and the provider gets a
 * 202 in milliseconds (GitHub gives up after 10 s). Results flow back to the
 * provider as check runs / commit statuses and one sticky PR comment.
 *
 * Fork PRs never build automatically (fork protection): they run code from
 * someone who is not a collaborator.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { decryptSecret } from '@swarmy/core/crypto';
import { prisma } from '@swarmy/db';
import {
  handleBranchPush,
  isAppBinding,
  planCommitForRepo,
  previewCommentBody,
  teardownAppPreviewForRepo,
  triggerBuildForRepo,
  upsertPrComment,
} from '@swarmy/trpc';
import { authRegistry } from '@swarmy/auth';
import { hub } from './gateway';
import {
  DeliveryDeduper,
  githubSignature,
  isForkPullRequest,
  parseCommitSha,
  parsePrWebhookEvent,
  parsePushRef,
  pushChangedPaths,
  safeEqual,
  verifyGiteaSignature,
  verifySwarmySignature,
  verifyWebhookSignature,
  type PrWebhookEvent,
  type WebhookProvider,
} from './webhook-verify';

export const webhooksApp = new Hono();

/**
 * Webhooks are unauthenticated until the HMAC check, which needs the whole
 * raw body (and `/github` tries every App secret) — so cap the body BEFORE
 * reading it. GitHub truncates push payloads (20 commits); 10 MB is generous.
 * bodyLimit also counts chunked bodies, which carry no Content-Length.
 */
export const WEBHOOK_MAX_BODY_BYTES = 10 * 1024 * 1024;
webhooksApp.use(
  '*',
  bodyLimit({ maxSize: WEBHOOK_MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload too large' }, 413) }),
);

const deliveries = new DeliveryDeduper();
const deps = () => ({ db: prisma, hub, auth: authRegistry.getAuth() });

const REPO_SELECT = {
  id: true,
  orgId: true,
  url: true,
  branch: true,
  provider: true,
  webhookSecretEnc: true,
  connectionId: true,
  fullName: true,
  externalRepoId: true,
  serviceId: true,
  envBranches: true,
} as const;
type RepoHookRow = {
  id: string;
  orgId: string;
  url: string;
  branch: string;
  provider: string;
  connectionId: string | null;
  fullName: string | null;
  externalRepoId: string | null;
  serviceId: string | null;
  envBranches: unknown;
};

/** The branch a PR/MR targets (GitHub/Gitea `pull_request.base.ref`, GitLab `target_branch`). */
function prBaseRef(body: unknown): string | undefined {
  const b = body as {
    pull_request?: { base?: { ref?: string } };
    object_attributes?: { target_branch?: string };
  };
  return b?.pull_request?.base?.ref ?? b?.object_attributes?.target_branch ?? undefined;
}

/** Does a push to `ref` concern this binding? (its branch, or one of its swarmy.yaml environments) */
function deploysFrom(r: RepoHookRow, ref: string): boolean {
  return (
    r.branch === ref ||
    (isAppBinding(r) && Array.isArray(r.envBranches) && r.envBranches.includes(ref))
  );
}

/**
 * A push to an app binding: the GitOps loop (plan → check run → apply). A
 * legacy binding (one linked service) keeps build-and-redeploy.
 */
/** GitHub `deleted: true`; GitLab/Gitea: the new sha is all zeros. */
function isBranchDelete(body: unknown): boolean {
  const b = body as { deleted?: boolean; after?: string };
  return b?.deleted === true || (typeof b?.after === 'string' && /^0+$/.test(b.after));
}

/** A push to a non-deploy branch of an app: branch preview (or teardown on delete). */
function kickBranch(r: RepoHookRow, ref: string, sha: string | null, deleted: boolean): void {
  void handleBranchPush(deps(), r.orgId, { repoId: r.id, ref, sha, deleted }).catch(
    (e: unknown) => {
      console.warn(
        `[webhooks] branch preview for ${r.url}@${ref} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    },
  );
}

function kickPush(
  r: RepoHookRow,
  ref: string,
  sha: string | null,
  changedPaths: string[] | undefined,
): void {
  if (!isAppBinding(r)) return kickBuild(r, ref, sha);
  void planCommitForRepo(deps(), r.orgId, {
    repoId: r.id,
    ref,
    sha,
    trigger: 'push',
    ...(changedPaths ? { changedPaths } : {}),
  })
    .then((res) => {
      // No swarmy.yaml at this commit: behave like a plain build repo.
      if (res.status === 'no-config' && ref === r.branch) kickBuild(r, ref, sha);
    })
    .catch((e: unknown) => {
      console.warn(
        `[webhooks] app plan for ${r.url}@${ref} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
}

/** A PR on an app binding deploys (or tears down) its swarmy.yaml preview. */
function kickPr(r: RepoHookRow, pr: PrWebhookEvent, baseRef?: string): void {
  if (!isAppBinding(r)) return;
  const run =
    pr.action === 'closed'
      ? teardownAppPreviewForRepo(deps(), r.orgId, { repoId: r.id, prNumber: pr.prNumber }).then(
          async (res) => {
            if (res.stack) {
              await upsertPrComment(prisma, r, {
                pr: pr.prNumber,
                key: `preview:${r.id}`,
                body: previewCommentBody({
                  stack: res.stack,
                  url: null,
                  sha: pr.commit,
                  state: 'torn-down',
                }),
              });
            }
          },
        )
      : planCommitForRepo(deps(), r.orgId, {
          repoId: r.id,
          ref: pr.branch,
          ...(baseRef ? { baseRef } : {}),
          sha: pr.commit,
          trigger: 'pr',
          prNumber: pr.prNumber,
        });
  void Promise.resolve(run).catch((e: unknown) => {
    console.warn(
      `[webhooks] app preview for ${r.url}#${pr.prNumber} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

/** Fire-and-forget a build of `sha` for one repo binding (errors land in the build row + check run). */
function kickBuild(repo: RepoHookRow, ref: string, sha: string | null): void {
  void triggerBuildForRepo(deps(), { repoId: repo.id, orgId: repo.orgId, ref, commit: sha }).catch(
    (e: unknown) => {
      console.warn(
        `[webhooks] build for ${repo.url}@${ref} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    },
  );
}

// ── GitHub App (one endpoint for every installation) ─────────────────────────

webhooksApp.post('/github', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('x-hub-signature-256');
  if (!signature) return c.json({ error: 'missing signature' }, 401);

  // One App per controller (per GitHub host) — try each registered App's secret.
  const apps = await prisma.gitHubApp.findMany({ select: { id: true, webhookSecretEnc: true } });
  const app = apps.find((a) =>
    safeEqual(signature, githubSignature(decryptSecret(a.webhookSecretEnc), rawBody)),
  );
  if (!app) return c.json({ error: 'invalid signature' }, 401);

  if (!deliveries.firstSeen(c.req.header('x-github-delivery')))
    return c.json({ ok: true, ignored: 'duplicate' });
  const event = c.req.header('x-github-event') ?? '';
  if (event === 'ping') return c.json({ ok: true, ignored: 'ping' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'malformed body' }, 400);
  }
  const installationId = String((body.installation as { id?: number } | undefined)?.id ?? '');

  // Installation lifecycle: uninstall/suspend disables the org's connection.
  if (event === 'installation' && installationId) {
    const action = String(body.action ?? '');
    const status =
      action === 'deleted' || action === 'suspend'
        ? 'suspended'
        : action === 'unsuspend'
          ? 'active'
          : null;
    if (status) {
      await prisma.gitConnection.updateMany({
        where: { githubAppId: app.id, installationId },
        data: { status },
      });
    }
    return c.json({ ok: true, installation: action });
  }

  const repoExternalId = String((body.repository as { id?: number } | undefined)?.id ?? '');
  if (!repoExternalId || !installationId) return c.json({ ok: true, ignored: event || 'event' });
  const repos: RepoHookRow[] = await prisma.gitRepo.findMany({
    where: {
      externalRepoId: repoExternalId,
      connection: { is: { githubAppId: app.id, installationId, status: 'active' } },
    },
    select: REPO_SELECT,
  });
  if (!repos.length) return c.json({ ok: true, ignored: 'unlinked repo' });

  if (event === 'push') {
    const ref = parsePushRef('github', body);
    const sha = parseCommitSha('github', body);
    if (!ref) return c.json({ ok: true, ignored: 'no ref' });
    const deleted = body.deleted === true;
    // Branches no deploy watches: maybe a branch preview (or its teardown).
    for (const r of repos.filter((x) => isAppBinding(x) && !deploysFrom(x, ref)))
      kickBranch(r, ref, sha, deleted);
    if (deleted) return c.json({ ok: true, ignored: 'branch deleted' });
    const matched = repos.filter((r) => deploysFrom(r, ref));
    const changed = pushChangedPaths(body);
    for (const r of matched) kickPush(r, ref, sha, changed);
    return c.json(
      { ok: true, accepted: matched.map((r) => r.id), ref },
      matched.length ? 202 : 200,
    );
  }

  if (event === 'pull_request') {
    const pr = parsePrWebhookEvent('github', event, body);
    if (!pr) return c.json({ ok: true, ignored: 'pr action' });
    if (pr.action !== 'closed' && isForkPullRequest('github', body)) {
      return c.json({
        ok: true,
        ignored: 'fork pull request (fork PRs never build automatically)',
      });
    }
    const baseRef = String(
      (body.pull_request as { base?: { ref?: string } } | undefined)?.base?.ref ?? '',
    );
    const matched = repos.filter((r) => !baseRef || r.branch === baseRef);
    for (const r of matched) kickPr(r, pr, baseRef || undefined);
    return c.json(
      { ok: true, pr: pr.prNumber, accepted: matched.map((r) => r.id) },
      matched.length ? 202 : 200,
    );
  }

  return c.json({ ok: true, ignored: event || 'event' });
});

// ── Per-repo hooks (GitLab / Gitea / generic / legacy GitHub) ────────────────

function providerOf(kind: string): 'github' | 'gitlab' | 'gitea' | 'generic' {
  return kind === 'GITLAB'
    ? 'gitlab'
    : kind === 'GITEA'
      ? 'gitea'
      : kind === 'GENERIC'
        ? 'generic'
        : 'github';
}

webhooksApp.post('/git/:repoId', async (c) => {
  const repoId = c.req.param('repoId');
  const rawBody = await c.req.text();

  const repo = await prisma.gitRepo.findUnique({ where: { id: repoId }, select: REPO_SELECT });
  if (!repo) return c.json({ error: 'unknown repo' }, 404);
  if (!repo.webhookSecretEnc) return c.json({ error: 'webhook not configured' }, 400);

  const kind = providerOf(repo.provider);
  const secret = decryptSecret(repo.webhookSecretEnc);
  const ok =
    kind === 'gitea'
      ? verifyGiteaSignature(secret, rawBody, c.req.header('x-gitea-signature'))
      : kind === 'generic'
        ? verifySwarmySignature(secret, rawBody, c.req.header('x-swarmy-signature')) ||
          verifyWebhookSignature({
            provider: 'github',
            secret,
            rawBody,
            githubSignature: c.req.header('x-hub-signature-256'),
          })
        : verifyWebhookSignature({
            provider: kind,
            secret,
            rawBody,
            githubSignature: c.req.header('x-hub-signature-256'),
            gitlabToken: c.req.header('x-gitlab-token'),
          });
  if (!ok) return c.json({ error: 'invalid signature' }, 401);

  const delivery =
    c.req.header('x-github-delivery') ??
    c.req.header('x-gitea-delivery') ??
    c.req.header('x-gitlab-event-uuid');
  if (!deliveries.firstSeen(delivery)) return c.json({ ok: true, ignored: 'duplicate' });

  const event =
    c.req.header('x-github-event') ??
    c.req.header('x-gitea-event') ??
    c.req.header('x-gitlab-event');
  if (event && /ping/i.test(event)) return c.json({ ok: true, ignored: 'ping' });

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'malformed body' }, 400);
  }

  // Payload dialect: Gitea/generic speak GitHub's push/PR shape.
  const dialect: WebhookProvider = kind === 'gitlab' ? 'gitlab' : 'github';

  // PR / MR → preview (same verification already applied).
  const pr = parsePrWebhookEvent(dialect, event ?? null, body);
  if (pr) {
    if (
      pr.action !== 'closed' &&
      isForkPullRequest(kind === 'gitlab' ? 'gitlab' : kind === 'gitea' ? 'gitea' : 'github', body)
    ) {
      return c.json({
        ok: true,
        ignored: 'fork pull request (fork PRs never build automatically)',
      });
    }
    kickPr(repo, pr, prBaseRef(body));
    return c.json({ ok: true, pr: pr.prNumber, accepted: true }, 202);
  }

  const ref = parsePushRef(dialect, body);
  // Only build the watched branch (defensive — providers can be configured broadly).
  if (ref && repo.branch && !deploysFrom(repo, ref)) {
    if (isAppBinding(repo)) {
      kickBranch(repo, ref, parseCommitSha(dialect, body), isBranchDelete(body));
      return c.json({ ok: true, branch: ref, accepted: true }, 202);
    }
    return c.json({ ok: true, ignored: 'branch', ref });
  }
  const buildRef = ref ?? repo.branch;
  kickPush(repo, buildRef, parseCommitSha(dialect, body), pushChangedPaths(body));
  return c.json({ ok: true, accepted: true, ref: buildRef }, 202);
});
