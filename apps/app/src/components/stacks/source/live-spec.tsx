import * as React from 'react';
import { isSystemStack } from '@swarmy/core';
import { CodeView, SayHeader } from '@/components/calm';
import { useApps } from '@/components/apps/use-apps';
import { AppSource } from '@/components/gitops/app-source';
import type { StackAppMatch } from '@/components/gitops/gitops-types';
import { CardSkeleton, HeaderSkeleton } from '@/components/states';
import { appCodeTabs } from '../workspace/app-code';
import { SourceActions } from './source-actions';

/**
 * Source for an app swarmy has no swarmy.yaml text for: the live spec as
 * compose, rebuilt from Docker, read-only. A git app lands here only when
 * its file can't be read right now (`notice` says why).
 */
export function LiveSpec({ stack, match, branch, pending, notice }: { stack: string; match: StackAppMatch | null; branch?: string; pending: boolean; notice?: string }): React.JSX.Element {
  const a = useApps();
  const app = [...a.apps, ...a.platform].find((x) => x.name === stack);
  const system = isSystemStack(stack);
  return (
    <div className="flex flex-col gap-5 pb-24 lg:pb-12">
      {pending && !system ? (
        <HeaderSkeleton />
      ) : (
        <SayHeader
          size="md"
          title={<>{stack} runs from this spec.</>}
          lede={
            system
              ? 'Read-only. swarmy manages this one itself and keeps it up to date.'
              : 'Read-only here. Edit it in git and swarmy rolls it out.'
          }
          actions={system ? undefined : <SourceActions app={match?.app ?? null} branch={branch} />}
        />
      )}
      {match ? <AppSource app={match.app} branch={branch} /> : null}
      {notice ? <p className="text-muted-foreground text-[13.5px]">{notice}</p> : null}
      {!match && !system && !pending ? (
        <p className="text-muted-foreground text-[13.5px]">
          This app isn&apos;t linked to a repo yet. Link one and its swarmy.yaml opens here, checked as you type.
        </p>
      ) : null}
      {app ? <CodeView always title="Live spec" tabs={appCodeTabs(app, null)} source="readonly" /> : <CardSkeleton lines={10} />}
    </div>
  );
}
