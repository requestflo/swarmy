import { useQuery } from '@tanstack/react-query';
import { findStackApp, type AppEnvironment, type GitApp } from '@/components/gitops/gitops-types';
import { useTRPC } from '@/integrations/trpc';

export interface AppDriftState {
  /** The git app and environment this app deploys from; null = not git-managed; undefined while loading. */
  git: { app: GitApp; env: AppEnvironment } | null | undefined;
  /** Changes live that aren't in swarmy.yaml (this environment); null until checked. */
  changes: number | null;
  checkedAt: string | null;
}

/**
 * Drift for a git-managed app: `apps.drift` compares the last applied commit
 * with what's running. It runs on open and again after every change made on
 * this page (mutations invalidate every query), so the banner is current.
 */
export function useAppDrift(stack: string): AppDriftState {
  const trpc = useTRPC();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 30_000 });
  const match = apps.data ? findStackApp(apps.data, stack) : apps.isError ? null : undefined;
  const git = match === undefined ? undefined : match?.kind === 'env' ? { app: match.app, env: match.env } : null;
  const repoId = git?.app.repoId ?? '';
  const check = useQuery({ ...trpc.apps.drift.queryOptions({ repoId }), enabled: !!git, staleTime: 30_000, retry: false });
  const drift = check.data ?? git?.app.drift ?? null;
  const env = drift?.environments.find((e) => e.stack === stack);
  return {
    git,
    changes: drift ? (env?.changes ?? 0) : null,
    checkedAt: drift?.checkedAt ?? null,
  };
}
