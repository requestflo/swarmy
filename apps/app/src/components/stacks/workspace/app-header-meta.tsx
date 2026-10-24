import * as React from 'react';
import { GitBranchIcon } from 'lucide-react';
import { sha7 } from '@/components/gitops/plan-status';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';
import { relTime } from '@/lib/format';
import type { AppHeaderFacts } from './use-app-header-facts';

const Dot = (): React.JSX.Element => (
  <span aria-hidden className="text-muted-foreground/60">
    ·
  </span>
);

/**
 * The quiet line under the app's sentence: the environment chip, where it is
 * managed from ("swarmy.yaml @ main · a1b2c3d", git apps only) and the newest
 * release with its age. On phones only the chip and the release stay.
 */
export function AppHeaderMeta({ facts }: { facts: AppHeaderFacts }): React.JSX.Element | null {
  const { env, git, release } = facts;
  if (!env && !git && !release) return null;
  return (
    <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      {env ? (
        <span className="border-border text-foreground rounded-full border px-2 py-px font-mono text-[11.5px] font-semibold">{env}</span>
      ) : null}
      {git ? (
        <span className="hidden min-w-0 items-center gap-2 sm:inline-flex">
          {env ? <Dot /> : null}
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            Managed by <span className="text-foreground font-mono text-[12px]">{git.configPath}</span> @{' '}
            <span className="text-foreground font-mono text-[12px]">{git.ref}</span>
            {git.sha ? <span className="font-mono text-[12px]"> · {sha7(git.sha)}</span> : null}
          </span>
        </span>
      ) : null}
      {release ? (
        <span className="inline-flex items-center gap-2">
          {env || git ? <Dot /> : null}
          <span>
            <span className="text-foreground font-mono text-[12px]">{releaseLabel(release)}</span> · {relTime(release.createdAt)}
          </span>
        </span>
      ) : null}
    </span>
  );
}
