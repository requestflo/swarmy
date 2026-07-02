import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { PreviewsSettingsCard } from './previews-settings-card';
import { PreviewsList } from './previews-list';

interface RepoRef {
  id: string;
  url: string;
}

interface PreviewsSectionProps {
  repos: RepoRef[];
}

/**
 * D4: PR preview environments — the Previews section of the CI page.
 * Left: per-repo settings (enable, base domain, TTL) + "preview a branch".
 * Right: the live preview stacks (PR, branch, link, age, destroy).
 */
export function PreviewsSection({ repos }: PreviewsSectionProps): React.JSX.Element {
  const trpc = useTRPC();
  const previews = useQuery({ ...trpc.previews.list.queryOptions(), refetchInterval: 5_000 });

  return (
    <section className="mt-8">
      <div className="mb-3">
        <h2 className="headline text-2xl">Previews</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Every pull request gets its own throwaway copy of your stack at{' '}
          <span className="mono-data">pr-&lt;N&gt;.your-domain</span> — merged or stale previews tear
          themselves down.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <PreviewsSettingsCard repos={repos} />
        <PreviewsList
          previews={previews.data}
          isLoading={previews.isLoading}
          isError={previews.isError}
          onRetry={() => void previews.refetch()}
        />
      </div>
    </section>
  );
}
