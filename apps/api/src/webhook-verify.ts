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
