import * as React from 'react';
import { Button } from '@swarmy/ui';
import { ErrorState, TextSkeleton } from '@/components/states';
import { GitConnectPanel } from './git-connect-panel';
import { GitFolderPicker } from './git-folder-picker';
import { GitLinkedView } from './git-linked-view';
import { GitProviderCards } from './git-provider-cards';
import { GitReceipt, type GitRoundTrip } from './git-receipt';
import { GitRepoStep } from './git-repo-step';
import type { GitReturn } from './git-return';
import { GitStepper } from './git-stepper';
import type { GitLink } from './use-git-link';
import type { GitWizard as Wizard } from './use-git-wizard';
import type { LinkedApps } from './use-linked-apps';

interface GitWizardProps {
  w: Wizard;
  l: GitLink;
  apps: LinkedApps;
  /** Back from a provider round trip (the receipt). */
  trip?: GitRoundTrip | null;
  onTripDismiss?: () => void;
  returnTo?: GitReturn['to'];
  onClose?: () => void;
}

/**
 * "Connect a repo" (board 23), the first-run path for git apps: four steps —
 * provider · repo · branch & folder · scan. A provider that isn't connected
 * yet connects right here (GitHub's own App in one click); its aside is
 * `GitFoundPanel`, which holds the one coral action.
 */
export function GitWizard({ w, l, apps, trip, onTripDismiss, returnTo, onClose }: GitWizardProps): React.JSX.Element {
  const done = [w.connected, Boolean(w.repo) || w.url.trim() !== '', Boolean(w.source) && w.configPath !== '', Boolean(l.linked)] as const;

  const body = w.list.isPending ? (
    <TextSkeleton className="h-40 w-full rounded-2xl" />
  ) : w.list.isError ? (
    <ErrorState title="Couldn’t load your git providers." error={w.list.error} retry={() => void w.list.refetch()} />
  ) : l.linked ? (
    <GitLinkedView l={l} onDone={onClose} />
  ) : (
    <>
      <GitProviderCards value={w.provider} conns={w.conns} onPick={w.pickProvider} />
      {w.connected ? (
        <div className="grid gap-4 @3xl:grid-cols-2">
          <GitRepoStep w={w} apps={apps.namesFor} returnTo={returnTo} />
          <GitFolderPicker w={w} appAt={apps.at} />
        </div>
      ) : (
        <section aria-label="Connect" className="calm-card flex flex-col gap-3 px-5 py-4">
          <GitConnectPanel provider={w.provider} returnTo={returnTo} onConnected={() => void w.list.refetch()} />
        </section>
      )}
    </>
  );

  return (
    <div className="@container flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-[1.35rem] font-bold tracking-[-0.02em]">Connect a repo</h2>
        <span className="text-muted-foreground text-[13.5px]">Builds run on your servers. No external CI.</span>
        {onClose && !l.linked ? (
          <Button variant="ghost" size="sm" className="ml-auto pointer-coarse:min-h-11" onClick={onClose}>
            Back
          </Button>
        ) : null}
      </div>
      <GitStepper done={done} />
      {trip?.git ? <GitReceipt trip={trip} conns={w.conns} onDismiss={() => onTripDismiss?.()} /> : null}
      {body}
    </div>
  );
}
