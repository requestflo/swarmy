import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, type CodeTab } from '@/components/calm';
import type { AppItem } from '@/components/apps/use-apps';
import { nodesRest, stacksRest, statusCli } from '@/components/apps/estate-code';

/** The Overview at Code depth: `swarmy status` per app, and the REST calls behind the lists. */
export function OverviewCode({ apps, nodes }: { apps: AppItem[]; nodes: NodeSummary[] }): React.JSX.Element {
  const trpc = useTRPC();
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  const tabs: CodeTab[] = [
    ...(apps.length ? [{ label: 'swarmy CLI', code: statusCli(apps) }] : []),
    { label: 'REST apps', code: stacksRest(stacks.data ?? []) },
    { label: 'REST servers', code: nodesRest(nodes) },
  ];
  return <CodeView tabs={tabs} source="readonly" />;
}
