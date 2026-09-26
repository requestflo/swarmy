import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { isSystemStack } from '@swarmy/core';
import { CodeView, SayHeader } from '@/components/calm';
import { useApps } from '@/components/apps/use-apps';
import { AppSource } from '@/components/gitops/app-source';
import { findStackApp } from '@/components/gitops/gitops-types';
import { CardSkeleton, HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { appCodeTabs } from '../workspace/app-code';
import { SourceActions } from './source-actions';

/**
 * Source (board AppCanvas's last tab): the spec this app runs from, read-only
 * — the live spec as compose, rebuilt from Docker. Editing happens in git
 * ("Edit in git ↗" when the app is git-linked); swarmy.yaml editing in the
 * dashboard is deferred (plans/redesign-build.md §7).
 */
export function SourceTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const a = useApps();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 30_000 });
  const app = [...a.apps, ...a.platform].find((x) => x.name === stack);
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  const branch = match?.kind === 'env' ? match.env.branch : match?.kind === 'preview' ? match.preview.branch : undefined;
  const system = isSystemStack(stack);

  return (
    <div className="flex flex-col gap-5 pb-24 lg:pb-12">
      {apps.isPending && !system ? (
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
      {match ? (
        <AppSource app={match.app} branch={branch} />
      ) : !system && apps.data ? (
        <p className="text-muted-foreground text-[13.5px]">
          This app isn&apos;t linked to a repo yet. Editing its swarmy.yaml here in the dashboard is coming later; for now,
          link a repo and change it there.
        </p>
      ) : null}
      {app ? (
        <CodeView always title="Live spec" tabs={appCodeTabs(app, null)} source="readonly" />
      ) : (
        <CardSkeleton lines={10} />
      )}
    </div>
  );
}
