/**
 * Branch previews (any branch, not just PRs): which branches get one, and
 * how a branch maps to a preview's identity. Pure.
 */

/**
 * Glob match for branch patterns: `*` = any run of characters except `/`,
 * `**` = anything (including `/`), `?` = one character except `/`.
 * `feature/*` matches `feature/login` but not `feature/a/b`; `feature/**` matches both.
 */
export function matchBranchPattern(pattern: string, branch: string): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`).test(branch);
}

export function branchMatchesAny(patterns: readonly string[], branch: string): boolean {
  return patterns.some((p) => matchBranchPattern(p, branch));
}

function fnv32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** DNS/stack-safe slug for a branch: `feature/Login_Page` → `feature-login-page`, ≤ 24 chars + a short hash when trimmed. */
export function branchSlug(branch: string): string {
  const base = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= 24 && base.length > 0) return base;
  const hash = fnv32(branch).toString(36).slice(0, 5);
  return `${base.slice(0, 18).replace(/-+$/, '')}-${hash}`;
}

/**
 * The numeric preview id a branch preview is keyed by (alongside PR numbers,
 * which stay below it). Stable per branch name.
 */
export const BRANCH_PREVIEW_ID_BASE = 1_000_000_000;
export function branchPreviewId(branch: string): number {
  return BRANCH_PREVIEW_ID_BASE + (fnv32(branch) % 1_000_000_000);
}
export const isBranchPreviewId = (id: number): boolean => id >= BRANCH_PREVIEW_ID_BASE;
