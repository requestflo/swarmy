import { useQuery } from '@tanstack/react-query';
import { findStackApp, previewLabel, type StackAppMatch } from '@/components/gitops/gitops-types';
import { envLabel } from '@/components/gitops/plan-status';
import { useTRPC } from '@/integrations/trpc';

export interface EnvTab {
  key: string;
  label: string;
  /** The stack this tab reads. */
  stack: string;
  /** "Showing PR #142 · each preview gets its own copy". */
  note?: string;
}

/**
 * Production / Staging / Previews for a git app (`apps.list`): each tab is
 * that environment's own stack. A stack no swarmy.yaml owns gets no tabs.
 */
export function envTabsFor(stack: string, match: StackAppMatch | null): EnvTab[] {
  if (!match) return [];
  const { app } = match;
  const envs: EnvTab[] = app.environments.map((e) => ({ key: e.environment, label: envLabel(e.environment), stack: e.stack }));
  const current = match.kind === 'preview' ? match.preview : app.previews[0];
  if (current) {
    const n = app.previews.length;
    envs.push({
      key: 'previews',
      label: 'Previews',
      stack: current.stack,
      note: `Showing ${previewLabel(current)}${n > 1 ? ` of ${n}` : ''} · each preview gets its own database, cache and bucket`,
    });
  }
  return envs.some((e) => e.stack === stack) ? envs : [];
}

export function useEnvTabs(stack: string): { tabs: EnvTab[]; match: StackAppMatch | null | undefined } {
  const trpc = useTRPC();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const match = apps.data ? findStackApp(apps.data, stack) : apps.isError ? null : undefined;
  return { tabs: match ? envTabsFor(stack, match) : [], match };
}
