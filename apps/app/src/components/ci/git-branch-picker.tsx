import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { TextSkeleton } from '@/components/states';

interface GitBranchPickerProps {
  connectionId: string;
  /** Full name (GitHub) or project id (GitLab) — see `branchRepoKey`. */
  repoKey: string;
  value: string;
  onChange: (branch: string) => void;
}

/** Step 3 — which branch deploys. The repo's default branch arrives preselected. */
export function GitBranchPicker({
  connectionId,
  repoKey,
  value,
  onChange,
}: GitBranchPickerProps): React.JSX.Element {
  const trpc = useTRPC();
  const branches = useQuery(
    trpc.gitConnections.branches.queryOptions({ connectionId, repo: repoKey }),
  );

  if (branches.isPending) return <TextSkeleton className="h-9 w-full rounded-full" />;
  const names = branches.data?.map((b) => b.name) ?? [];
  if (value && !names.includes(value)) names.unshift(value);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="mono-data">
        <SelectValue placeholder="Pick a branch" />
      </SelectTrigger>
      <SelectContent>
        {names.map((n) => (
          <SelectItem key={n} value={n} className="mono-data">
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
