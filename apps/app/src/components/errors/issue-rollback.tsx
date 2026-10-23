import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Undo2Icon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Tech } from '@/components/calm';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';
import { RollbackConfirm } from '@/components/releases/rollback-confirm';
import { shortRelease } from './errors-shared';
import { rollbackTarget } from './issue-chart-math';

/**
 * "Put back vN" — offered only when the issue came in with the release that is
 * running now (linked by the deploy's swarmy release id), so putting back the
 * last good version actually removes the code that throws.
 */
export function IssueRollback({
  stack,
  introduced,
}: {
  stack: string;
  introduced: { version: string; swarmyReleaseId: string | null } | null;
}): React.JSX.Element | null {
  const trpc = useTRPC();
  const id = introduced?.swarmyReleaseId ?? null;
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ stackName: stack, limit: 30 }), enabled: !!id });
  const target = releases.data ? rollbackTarget(releases.data, id) : null;
  if (!introduced || !target) return null;
  const good = releaseLabel(target);
  return (
    <div className="border-border flex flex-wrap items-center gap-3 border-t pt-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          It came in with {shortRelease(introduced.version)}, the version running now. Putting back {good} takes the
          change out.
        </p>
        <Tech>releases.rollback · redeploys {target.images.map((i) => i.image).join(', ')} as a new release</Tech>
      </div>
      <RollbackConfirm
        release={target}
        label={good}
        trigger={
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11">
            <Undo2Icon className="size-4" /> Put back {good}
          </Button>
        }
      />
    </div>
  );
}
