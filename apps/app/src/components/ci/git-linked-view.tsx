import * as React from 'react';
import { Button } from '@swarmy/ui';
import { GitLinkDetect } from './git-link-detect';
import { GitLinkSecrets } from './git-link-secrets';
import type { GitLink } from './use-git-link';

/** After Link & scan: the one-time reveal (webhook / deploy key) and what the linked commit holds. */
export function GitLinkedView({ l, onDone }: { l: GitLink; onDone?: () => void }): React.JSX.Element | null {
  const linked = l.linked;
  if (!linked) return null;
  return (
    <div className="calm-card flex flex-col gap-5 px-5 py-5">
      <p className="text-lg font-semibold">
        Linked <span className="font-mono">{linked.fullName ?? linked.url}</span> on <span className="font-mono">{linked.branch}</span>.
      </p>
      <GitLinkSecrets linked={linked} />
      <GitLinkDetect
        linked={linked}
        inspect={l.inspect}
        switching={l.update.isPending}
        onUsePath={(configPath) => l.update.mutate({ id: linked.id, configPath })}
      />
      {onDone ? (
        <div className="flex justify-end">
          <Button variant="outline" onClick={onDone} className="pointer-coarse:min-h-11">
            Done
          </Button>
        </div>
      ) : null}
    </div>
  );
}
