import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { findStackApp } from '@/components/gitops/gitops-types';
import { CardSkeleton, HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { LiveSpec } from './live-spec';
import { useConfigFile } from './use-config-file';
import { YamlWorkspace } from './yaml-workspace';

/**
 * Source (board YamlEditor): a git app's swarmy.yaml, in an editor that
 * checks it as you type and draws what it builds. Anything else — an app
 * with no repo, swarmy's own — keeps the read-only live spec.
 */
export function SourceTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 30_000 });
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  const branch =
    match?.kind === 'env' ? match.env.branch || match.app.branch : match?.kind === 'preview' ? (match.preview.branch ?? `PR #${match.preview.pr}`) : undefined;
  const file = useConfigFile(stack, Boolean(match));

  if (match && file.isPending) {
    return (
      <div className="flex flex-col gap-5">
        <HeaderSkeleton />
        <CardSkeleton lines={14} />
      </div>
    );
  }
  if (match && file.data?.text != null && branch) {
    return <YamlWorkspace stack={stack} app={match.app} branch={branch} file={file.data} text={file.data.text} />;
  }
  const notice = !match
    ? undefined
    : file.isError
      ? `Couldn't read swarmy.yaml from the repo just now (${file.error.message}). This is the live spec instead.`
      : file.data === null
        ? 'swarmy hasn’t planned a commit for this app yet, so there’s no swarmy.yaml to show. This is the live spec.'
        : `There’s no ${file.data?.path ?? 'swarmy.yaml'} at ${file.data?.sha.slice(0, 7) ?? 'that commit'}. This is the live spec.`;
  return <LiveSpec stack={stack} match={match} branch={branch} pending={apps.isPending} notice={notice} />;
}
