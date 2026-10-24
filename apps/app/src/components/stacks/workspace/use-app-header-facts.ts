import { useQuery } from '@tanstack/react-query';
import type { ReleaseView } from '@swarmy/core';
import { findStackApp, previewLabel } from '@/components/gitops/gitops-types';
import { useTRPC } from '@/integrations/trpc';

export interface AppGitBinding {
  /** The swarmy.yaml path in the repo ("swarmy.yaml", "deploy/swarmy.yaml"). */
  configPath: string;
  /** "main", or "PR #142" / "branch feature/x" for a preview. */
  ref: string;
  /** The commit of the last plan (null before the first one). */
  sha: string | null;
}

export interface AppHeaderFacts {
  /** "production", "staging", "preview" — the git environment, else the `swarmy.env` label; null when neither says. */
  env: string | null;
  /** Set for apps deployed from git (`apps.list`). */
  git: AppGitBinding | null;
  /** The newest release; null = none yet, undefined = still loading. */
  release: ReleaseView | null | undefined;
  /** The stack's config-row id for `stacks.redeploy`; null for label-only stacks (nothing stored to redeploy). */
  stackId: string | null;
}

/**
 * What the app header says beside the sentence: which environment this stack
 * is, the git binding it is managed from, and the newest release. Each part
 * stays empty until its read lands, so nothing in the header is a guess.
 */
export function useAppHeaderFacts(stack: string): AppHeaderFacts {
  const trpc = useTRPC();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const envs = useQuery({ ...trpc.guardrails.stackEnvs.queryOptions(), refetchInterval: 30_000 });
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ stackName: stack, limit: 1 }), refetchInterval: 15_000 });
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), refetchInterval: 5_000 });

  const match = apps.data ? findStackApp(apps.data, stack) : null;
  let git: AppGitBinding | null = null;
  let env: string | null = null;
  if (match?.kind === 'env') {
    env = match.env.environment;
    git = { configPath: match.app.configPath, ref: match.env.branch, sha: match.env.latest?.sha ?? null };
  } else if (match?.kind === 'preview') {
    env = 'preview';
    git = { configPath: match.app.configPath, ref: previewLabel(match.preview), sha: match.preview.sha || null };
  } else if (envs.data?.find((e) => e.stack === stack)?.production) {
    env = 'production';
  }
  const row = stacks.data?.find((s) => s.name === stack);
  return {
    env,
    git,
    release: releases.data ? (releases.data[0] ?? null) : undefined,
    // listStacks gives a label-only stack its name as id: there is no stored compose to redeploy.
    stackId: row && row.id !== row.name ? row.id : null,
  };
}
