import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { LockIcon, SearchIcon } from 'lucide-react';
import { cn, Input } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ErrorState, TextSkeleton } from '@/components/states';
import type { ProviderRepo } from './git-types';
import { useDebouncedValue } from './use-debounced-value';

interface GitRepoPickerProps {
  connectionId: string;
  value: ProviderRepo | null;
  onChange: (repo: ProviderRepo) => void;
}

/** Step 2 — a searchable list of the repos this connection can see. */
export function GitRepoPicker({
  connectionId,
  value,
  onChange,
}: GitRepoPickerProps): React.JSX.Element {
  const trpc = useTRPC();
  const [search, setSearch] = React.useState('');
  const q = useDebouncedValue(search.trim());
  const repos = useQuery({
    ...trpc.gitConnections.repos.queryOptions({ connectionId, search: q || undefined }),
    placeholderData: (prev) => prev,
  });

  return (
    <div className="space-y-2">
      <div className="relative">
        <SearchIcon className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search repos"
          className="pl-9"
        />
      </div>
      <div className="max-h-72 overflow-y-auto rounded-xl border">
        {repos.isPending ? (
          <div className="space-y-3 p-4">
            <TextSkeleton className="h-4 w-1/2" />
            <TextSkeleton className="h-4 w-2/5" />
          </div>
        ) : repos.isError ? (
          <ErrorState
            error={repos.error}
            retry={() => void repos.refetch()}
            className="shadow-none"
          />
        ) : repos.data.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">
            {q
              ? `Nothing matches “${q}”.`
              : 'No repos here yet — install the app on more repos, then come back.'}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {repos.data.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onChange(r)}
                  className={cn(
                    'hover:bg-accent/60 flex w-full items-center gap-3 border-l-[3px] border-transparent px-4 py-2.5 text-left transition-colors',
                    value?.id === r.id && 'bg-accent border-primary',
                  )}
                >
                  <span className="mono-data min-w-0 flex-1 truncate">{r.fullName}</span>
                  {r.private ? (
                    <LockIcon
                      className="text-muted-foreground size-3.5 shrink-0"
                      aria-label="private"
                    />
                  ) : null}
                  <span className="text-muted-foreground mono-label shrink-0">
                    {r.defaultBranch}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
