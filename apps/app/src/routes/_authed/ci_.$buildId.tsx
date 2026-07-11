import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { BuildLogViewer } from '@/components/ci/build-log-viewer';

export const Route = createFileRoute('/_authed/ci_/$buildId')({
  component: BuildDetailPage,
});

const RUNNING = new Set(['queued', 'building', 'pushing']);

function BuildDetailPage(): React.JSX.Element {
  const { buildId } = Route.useParams();
  const trpc = useTRPC();

  // The build row comes from the (refetching) list; cheap + avoids a new query.
  const builds = useQuery({
    ...trpc.cicd.listBuilds.queryOptions({}),
    refetchInterval: 4000,
  });
  const build = builds.data?.find((b) => b.id === buildId);
  const status = build?.status ?? 'building';
  const live = RUNNING.has(status);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="CI / CD · Build"
        title={
          <>
            Build <em>log</em>.
          </>
        }
        description={build?.image ?? build?.repoUrl ?? buildId}
        actions={
          <Button asChild variant="ghost">
            <Link to="/ci">
              <ArrowLeftIcon className="size-4" /> Back to CI
            </Link>
          </Button>
        }
      />

      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span className="mono-data truncate">{build?.commit ?? buildId}</span>
            <Badge variant="muted">
              <span className={live ? 'text-status-progress' : status === 'failed' ? 'text-status-offline' : 'text-status-online'}>
                {status}
              </span>
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <BuildLogViewer buildId={buildId} live={live} />
        </CardContent>
      </Card>
    </div>
  );
}
