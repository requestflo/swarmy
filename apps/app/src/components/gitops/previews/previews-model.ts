import type { AppPreview, PreviewRules } from '../gitops-types';

/**
 * Branch previews in words (board BranchPreviews), from the app's preview
 * list and production swarmy.yaml's `previews:` rules. PURE — unit-tested.
 */

/** "48 h" · "3 d" · "90 min". */
export function duration(seconds: number): string {
  if (seconds >= 7 * 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400} d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)} h`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/** "31 h left" — previews go `ttl` after their last push; 0 = kept until the branch or PR goes. */
export function ttlLeft(p: AppPreview, rules: PreviewRules | null | undefined, now = Date.now()): string {
  const ttl = rules?.ttlSeconds ?? 0;
  if (!ttl) return p.branch ? 'kept until the branch is deleted' : 'kept until the PR closes';
  const left = Math.round((Date.parse(p.updatedAt) + ttl * 1000 - now) / 1000);
  return left <= 0 ? 'due to be cleaned up' : `${duration(left)} left`;
}

/**
 * "Pull requests and branches matching feature/*" · "Pull requests only" ·
 * off: `previews.enabled` is the master switch for automatic previews (one
 * started here still runs — the trial-deploy path).
 */
export function branchesWords(rules: PreviewRules): string {
  if (!rules.enabled) return 'Off — only the ones you start here';
  return rules.branches.length ? `Pull requests and branches matching ${rules.branches.join(', ')}` : 'Pull requests only';
}

/** What a new preview's database starts as. */
export function dataWords(rules: PreviewRules): string {
  if (rules.resources === 'shared') return 'shares production’s resources — read with care';
  if (rules.data) return `a copy of ${rules.data.from}’s latest backup${rules.data.scrub ? `, scrubbed by ${rules.data.scrub}` : ''}`;
  return 'empty — migrations run, no customer data';
}

/** The previews: block as it reads in swarmy.yaml (for the Code view). */
export function rulesYaml(rules: PreviewRules): Record<string, unknown> {
  return {
    previews: {
      enabled: rules.enabled,
      ...(rules.ttlSeconds ? { ttl: duration(rules.ttlSeconds).replace(' ', '').replace('min', 'm') } : {}),
      ...(rules.resources !== 'isolated' ? { resources: rules.resources } : {}),
      ...(rules.branches.length ? { branches: rules.branches } : {}),
      ...(rules.data ? { data: rules.data } : {}),
    },
  };
}
