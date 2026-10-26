/**
 * The swarmy.yaml TEXT an app stack runs from, for the Source tab's editor.
 *
 * The GitOps loop reads the file through `git.inspect` on a Builder at every
 * plan, but persists only what it derived from it (AppPlan plan/desired/
 * issues/ledger). So the text lives in a small in-memory cache keyed by
 * commit — a commit never changes, so an entry is never stale: `planCommit`
 * remembers what it fetched, and a miss reads the stack's last planned commit
 * through the same `inspectCommit` path (no new git access).
 *
 * "When did a push last arrive" is history the AppPlan rows already hold: a
 * `push` / `pr` plan exists only after a verified webhook; `poll` is the
 * polling worker. Deliveries themselves aren't stored.
 */
import type { OrgContext } from '../../context';
import { inspectCommit } from '../git-connections.service';

const MAX_ENTRIES = 200;
const texts = new Map<string, { text: string | null; fetchedAt: string }>();
const keyOf = (repoId: string, sha: string, path: string): string => `${repoId}@${sha}:${path}`;

/** Keep the text the loop just read (LRU, bounded). `null` = no file at that commit. */
export function rememberConfigText(repoId: string, sha: string, path: string, text: string | null): void {
  const k = keyOf(repoId, sha, path);
  texts.delete(k);
  texts.set(k, { text, fetchedAt: new Date().toISOString() });
  while (texts.size > MAX_ENTRIES) {
    const oldest = texts.keys().next().value;
    if (oldest === undefined) break;
    texts.delete(oldest);
  }
}

export function cachedConfigText(repoId: string, sha: string, path: string): { text: string | null; fetchedAt: string } | null {
  const k = keyOf(repoId, sha, path);
  const hit = texts.get(k);
  if (!hit) return null;
  texts.delete(k); // most recently used goes last
  texts.set(k, hit);
  return hit;
}

export interface AppConfigFileView {
  repoId: string;
  environment: string;
  /** The file's path in the repo (`swarmy.yaml`, or a monorepo path). */
  path: string;
  /** The commit swarmy last planned for this stack. */
  sha: string;
  /** Null when that commit has no file at `path`. */
  text: string | null;
  fetchedAt: string;
  /** The latest webhook-driven plan (push / PR). */
  lastWebhookAt: string | null;
  /** The latest plan the polling worker started. */
  lastPollAt: string | null;
  /** The repo's preview base domain, used when swarmy.yaml doesn't set `previews.base_domain`. */
  previewDomain: string | null;
}

function legacyPreviewDomain(json: unknown): string | null {
  const v = typeof json === 'object' && json !== null ? (json as { baseDomain?: unknown }).baseDomain : undefined;
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

/**
 * The file's text at one commit: the cache, else one inspect on a Builder
 * (throws when none is online). `null` text = no file at that commit.
 */
export async function configTextAt(
  ctx: OrgContext,
  repo: { id: string; branch: string; configPath: string },
  sha: string,
  environment: string,
): Promise<{ text: string | null; fetchedAt: string }> {
  const hit = cachedConfigText(repo.id, sha, repo.configPath);
  if (hit) return hit;
  const inspected = await inspectCommit(ctx, {
    repoId: repo.id,
    ref: sha,
    paths: [repo.configPath],
    // A host that refuses a bare-sha fetch: find the sha in the branch's recent history.
    ...(environment === 'production' ? { fallbackBranch: repo.branch } : {}),
  });
  rememberConfigText(repo.id, sha, repo.configPath, inspected.files[repo.configPath] ?? null);
  return cachedConfigText(repo.id, sha, repo.configPath) ?? { text: null, fetchedAt: new Date().toISOString() };
}

/** The swarmy.yaml at the stack's last planned commit; null when the stack isn't a git app. */
export async function readAppConfigFile(ctx: OrgContext, input: { stack: string }): Promise<AppConfigFileView | null> {
  const plan = await ctx.db.appPlan.findFirst({
    where: { orgId: ctx.activeOrgId, stack: input.stack },
    orderBy: { createdAt: 'desc' },
    select: { repoId: true, environment: true, sha: true },
  });
  if (!plan) return null;
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: plan.repoId, orgId: ctx.activeOrgId },
    select: { id: true, branch: true, configPath: true, previewsJson: true },
  });
  if (!repo) return null;

  const file = await configTextAt(ctx, repo, plan.sha, plan.environment);

  const latest = (trigger: string[]) =>
    ctx.db.appPlan.findFirst({
      where: { orgId: ctx.activeOrgId, repoId: repo.id, trigger: { in: trigger } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  const [hook, poll] = await Promise.all([latest(['push', 'pr']), latest(['poll'])]);
  return {
    repoId: repo.id,
    environment: plan.environment,
    path: repo.configPath,
    sha: plan.sha,
    text: file.text,
    fetchedAt: file.fetchedAt,
    lastWebhookAt: hook?.createdAt.toISOString() ?? null,
    lastPollAt: poll?.createdAt.toISOString() ?? null,
    previewDomain: legacyPreviewDomain(repo.previewsJson),
  };
}
