/**
 * Pure webhook signature/payload helpers (epic: git-cicd-registry, PHASE-2).
 *
 * Split out from `webhooks.ts` (which wires Hono + the gateway + db) so the
 * crypto-only logic is unit-testable in isolation with no heavy imports.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookProvider = 'github' | 'gitlab';

export interface VerifyInput {
  provider: WebhookProvider;
  secret: string;
  /** Raw request body bytes (HMAC is computed over the exact bytes). */
  rawBody: string;
  /** GitHub `X-Hub-Signature-256` header (`sha256=…`), if present. */
  githubSignature?: string | null;
  /** GitLab `X-Gitlab-Token` header, if present. */
  gitlabToken?: string | null;
}

/** Constant-time string compare that never short-circuits on content. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Compute the GitHub `sha256=…` signature for a body + secret. */
export function githubSignature(secret: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verify a provider webhook signature against the repo's stored secret.
 * Returns true only on a constant-time match — no signature, no match.
 */
export function verifyWebhookSignature(input: VerifyInput): boolean {
  if (!input.secret) return false;
  if (input.provider === 'github') {
    if (!input.githubSignature) return false;
    return safeEqual(input.githubSignature, githubSignature(input.secret, input.rawBody));
  }
  if (!input.gitlabToken) return false;
  return safeEqual(input.gitlabToken, input.secret);
}

/** Extract the pushed ref (`refs/heads/main` → `main`) from a provider payload. */
export function parsePushRef(_provider: WebhookProvider, body: unknown): string | null {
  const b = body as { ref?: string };
  if (typeof b?.ref !== 'string') return null;
  return b.ref.replace(/^refs\/(heads|tags)\//, '');
}

/** Extract the head commit sha from a provider payload, if present. */
export function parseCommitSha(_provider: WebhookProvider, body: unknown): string | null {
  const b = body as { after?: string; checkout_sha?: string };
  return b?.after ?? b?.checkout_sha ?? null;
}

// ── git-apps (Phase 2): Gitea / generic signatures, fork PRs, changed paths, dedupe ──

/** Gitea/Forgejo `X-Gitea-Signature`: bare hex HMAC-SHA256 of the body. */
export function verifyGiteaSignature(secret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!secret || !header) return false;
  return safeEqual(header, createHmac('sha256', secret).update(rawBody).digest('hex'));
}

/** Generic git hosts: `X-Swarmy-Signature: sha256=<hex>` (GitHub's scheme, swarmy's header). */
export function verifySwarmySignature(secret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!secret || !header) return false;
  return safeEqual(header, githubSignature(secret, rawBody));
}

/**
 * Is this PR/MR from a fork? Fork PRs run code from someone who is not a
 * collaborator — swarmy never builds them automatically (fork protection).
 * Unknown shape → treated as a fork (fail closed).
 */
export function isForkPullRequest(provider: 'github' | 'gitlab' | 'gitea', body: unknown): boolean {
  const b = body as {
    pull_request?: { head?: { repo?: { full_name?: string; id?: number } | null }; base?: { repo?: { full_name?: string; id?: number } } };
    object_attributes?: { source_project_id?: number; target_project_id?: number };
  };
  if (provider === 'gitlab') {
    const oa = b?.object_attributes;
    if (!oa || oa.source_project_id === undefined || oa.target_project_id === undefined) return true;
    return oa.source_project_id !== oa.target_project_id;
  }
  const head = b?.pull_request?.head?.repo;
  const base = b?.pull_request?.base?.repo;
  if (!head || !base) return true; // head repo deleted, or not a PR payload
  return (head.id ?? head.full_name) !== (base.id ?? base.full_name);
}

/**
 * Paths a push changed, from the payload's commit list (GitHub/Gitea:
 * `commits[].added|modified|removed`). `undefined` = unknown (GitHub truncates
 * the list at 20 commits; a force-push/new branch has no usable list) → the
 * planner then rebuilds everything, which is always safe.
 */
export function pushChangedPaths(body: unknown): string[] | undefined {
  const b = body as {
    commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
    created?: boolean;
    forced?: boolean;
  };
  if (!Array.isArray(b?.commits) || b.commits.length === 0 || b.commits.length >= 20 || b.created || b.forced) {
    return undefined;
  }
  const out = new Set<string>();
  for (const c of b.commits) for (const p of [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]) out.add(p);
  return [...out].sort();
}

/** Bounded, TTL'd set of provider delivery ids — a redelivered webhook is acknowledged, not re-run. */
export class DeliveryDeduper {
  private seen = new Map<string, number>();
  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly max = 5000,
  ) {}
  /** True the FIRST time an id is seen (within the TTL); false for a duplicate. */
  firstSeen(id: string | null | undefined, now = Date.now()): boolean {
    if (!id) return true; // providers without delivery ids can't be deduped
    for (const [k, t] of this.seen) {
      if (now - t < this.ttlMs && this.seen.size <= this.max) break;
      this.seen.delete(k);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    return true;
  }
}

// ── Pull / merge request events ───────────────────────────────────────────────

export type PrAction = 'opened' | 'synchronize' | 'closed';

export interface PrWebhookEvent {
  action: PrAction;
  prNumber: number;
  branch: string;
  commit: string | null;
}

const GH_OPENED = new Set(['opened', 'reopened', 'ready_for_review']);
const GL_OPENED = new Set(['open', 'reopen']);
const GL_CLOSED = new Set(['close', 'merge']);

/**
 * Detect + normalize a GitHub `pull_request` / GitLab `Merge Request Hook`
 * payload. Returns null for anything else (pushes, pings, label churn …) so the
 * webhook receiver can fall through to its existing push handling.
 */
export function parsePrWebhookEvent(
  provider: 'github' | 'gitlab',
  eventHeader: string | null | undefined,
  body: unknown,
): PrWebhookEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;

  if (provider === 'github') {
    if (eventHeader !== 'pull_request') return null;
    const prObj = (b.pull_request ?? {}) as Record<string, unknown>;
    const head = (prObj.head ?? {}) as Record<string, unknown>;
    const number = typeof prObj.number === 'number' ? prObj.number : typeof b.number === 'number' ? b.number : Number.NaN;
    const branch = typeof head.ref === 'string' ? head.ref : '';
    if (!Number.isSafeInteger(number) || number < 1 || !branch) return null;
    const raw = typeof b.action === 'string' ? b.action : '';
    const action: PrAction | null = GH_OPENED.has(raw)
      ? 'opened'
      : raw === 'synchronize'
        ? 'synchronize'
        : raw === 'closed'
          ? 'closed'
          : null;
    if (!action) return null;
    return { action, prNumber: number, branch, commit: typeof head.sha === 'string' ? head.sha : null };
  }

  // gitlab — MR hooks mirror the push-hook token verification already applied.
  if (b.object_kind !== 'merge_request' && eventHeader !== 'Merge Request Hook') return null;
  const attrs = (b.object_attributes ?? {}) as Record<string, unknown>;
  const iid = typeof attrs.iid === 'number' ? attrs.iid : Number.NaN;
  const branch = typeof attrs.source_branch === 'string' ? attrs.source_branch : '';
  if (!Number.isSafeInteger(iid) || iid < 1 || !branch) return null;
  const raw = typeof attrs.action === 'string' ? attrs.action : '';
  const action: PrAction | null = GL_OPENED.has(raw)
    ? 'opened'
    : raw === 'update'
      ? 'synchronize'
      : GL_CLOSED.has(raw)
        ? 'closed'
        : null;
  if (!action) return null;
  const lastCommit = (attrs.last_commit ?? {}) as Record<string, unknown>;
  return { action, prNumber: iid, branch, commit: typeof lastCommit.id === 'string' ? lastCommit.id : null };
}
