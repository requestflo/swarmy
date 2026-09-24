import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BoxesIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ErrorState, TextSkeleton } from '@/components/states';
import { AppRow } from './app-row';
import { PlanDrawer } from './plan-drawer';

/** Apps deployed from a swarmy.yaml in git — each with its environments and plans. */
export function AppsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 10_000 });
  const [open, setOpen] = React.useState<{
    planId: string;
    configPath: string;
    promotedFrom?: string;
  } | null>(null);

  return (
    <Card className="card-pop mb-6 overflow-hidden border-0">
      <CardHeader>
        <CardTitle className="text-base">Apps from Git</CardTitle>
        <CardDescription>
          Each push plans the change. Safe steps ship on their own; anything that deletes data waits
          for you.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {apps.isPending ? (
          <div className="space-y-3 px-6 pb-6">
            <TextSkeleton className="h-4 w-1/2" />
            <TextSkeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : apps.isError ? (
          <div className="px-6 pb-6">
            <ErrorState
              error={apps.error}
              retry={() => void apps.refetch()}
              retrying={apps.isFetching}
            />
          </div>
        ) : apps.data.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon={<BoxesIcon />}
              title="No apps from Git yet"
              description="Use New app from Git to point swarmy at a repo with a swarmy.yaml."
            />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {apps.data.map((a) => (
              <AppRow
                key={a.repoId}
                app={a}
                onOpenPlan={(planId, configPath, promotedFrom) =>
                  setOpen({ planId, configPath, promotedFrom })
                }
              />
            ))}
          </div>
        )}
      </CardContent>
      <PlanDrawer
        planId={open?.planId ?? null}
        configPath={open?.configPath}
        promotedFrom={open?.promotedFrom}
        onClose={() => setOpen(null)}
      />
    </Card>
  );
}
