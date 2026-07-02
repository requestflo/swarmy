import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** "Preview a branch" — spin a preview up without waiting for a PR. */
export function PreviewBranchForm({ repoId }: { repoId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [branch, setBranch] = React.useState('');

  const create = useMutation(
    trpc.previews.createManual.mutationOptions({
      onSuccess: (r) => {
        if (r.action === 'deployed') {
          toast.success(`Preview ${r.stack ?? ''} is deploying`);
          setBranch('');
        } else {
          toast.error(r.reason ?? 'Preview skipped');
        }
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">Preview a branch</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-0 flex-1"
          placeholder="feat/my-branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && branch.trim()) create.mutate({ repoId, branch: branch.trim() });
          }}
        />
        <Button
          variant="outline"
          disabled={create.isPending || branch.trim().length === 0}
          onClick={() => create.mutate({ repoId, branch: branch.trim() })}
        >
          {create.isPending ? 'Building…' : 'Spin up'}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">Builds the branch and deploys it like a PR (previews must be enabled).</p>
    </div>
  );
}
