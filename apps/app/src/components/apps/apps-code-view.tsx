import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CodeView } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { appsRest, nodesRest, stacksRest, statusCli } from './estate-code';
import type { AppItem } from './use-apps';

/**
 * The Apps list as code: the REST calls behind each column (stacks, git
 * environments + previews, servers) and `swarmy status` per app.
 */
export function AppsCodeView({ apps }: { apps: AppItem[] }): React.JSX.Element {
  const trpc = useTRPC();
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  const gitApps = useQuery(trpc.apps.list.queryOptions());
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  return (
    <CodeView
      tabs={[
        { label: 'GET /stacks', code: stacksRest(stacks.data ?? []) },
        { label: 'GET /apps', code: appsRest(gitApps.data ?? []) },
        { label: 'GET /nodes', code: nodesRest(nodes.data ?? []) },
        { label: 'swarmy status', code: statusCli(apps) },
      ]}
      source="readonly"
    />
  );
}
