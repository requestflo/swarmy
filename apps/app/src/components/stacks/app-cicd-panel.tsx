import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HammerIcon, RocketIcon, Trash2Icon } from 'lucide-react';
import { Badge, Button, Skeleton, StatusBadge, type StatusTone, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AppCicdLinkForm } from './app-cicd-link-form';

interface AppCicdPanelProps {
  serviceId: string;
  serviceName: string;
}

const BUILD_TONE: Record<string, StatusTone> = {
  succeeded: 'online',
  building: 'progress',
  pushing: 'progress',
  queued: 'progress',
  failed: 'offline',
  canceled: 'neutral',
};
const buildTone = (s: string): StatusTone => BUILD_TONE[s] ?? 'neutral';

/**
 * Per-service CI/CD on the canvas service sheet: link a git repo to this
 * `serviceId`, build a ref on demand, and watch recent builds. With autodeploy on,
 * a successful build redeploys this service — the build-before-run path, surfaced.
 */
export function AppCicdPanel({ serviceId, serviceName }: AppCicdPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const repos = useQuery(trpc.cicd.listRepos.queryOptions());
  const builds = useQuery({ ...trpc.cicd.listBuilds.queryOptions({}), refetchInterval: 5_000 });

  const linked = (repos.data ?? []).filter((r) => r.serviceId === serviceId);
  const linkedIds = new Set(linked.map((r) => r.id));
  const recent = (builds.data ?? []).filter((b) => linkedIds.has(b.repoId)).slice(0, 4);

  const triggerBuild = useMutation(
    trpc.cicd.triggerBuild.mutationOptions({
      onSuccess: () => {
        toast.success('Build started');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const removeRepo = useMutation(
    trpc.cicd.removeRepo.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <RocketIcon className="text-status-progress size-4" /> Continuous deploy
      </p>

      {repos.isLoading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : linked.length === 0 ? (
        <AppCicdLinkForm serviceId={serviceId} />
      ) : (
        <div className="space-y-3">
          {linked.map((r) => (
            <div key={r.id} className="border-border space-y-2 rounded-xl border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="mono-data truncate text-sm font-medium">{r.url}</p>
                  <p className="text-muted-foreground mono-label truncate">
                    {r.provider} · {r.branch}
                    {r.autodeploy ? ' · autodeploy' : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Unlink repo"
                  disabled={removeRepo.isPending}
                  onClick={() => removeRepo.mutate({ id: r.id })}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={triggerBuild.isPending}
                  onClick={() => triggerBuild.mutate({ repoId: r.id })}
                >
                  <HammerIcon className="size-4" /> Build now
                </Button>
                {r.autodeploy ? (
                  <Badge variant="muted">deploys {serviceName} on green</Badge>
                ) : (
                  <span className="text-muted-foreground text-xs">manual deploy</span>
                )}
              </div>
            </div>
          ))}

          {recent.length > 0 && (
            <div className="border-border overflow-hidden rounded-xl border">
              {recent.map((b) => (
                <Link
                  key={b.id}
                  to="/ci/$buildId"
                  params={{ buildId: b.id }}
                  className="hover:bg-accent/60 flex items-center justify-between gap-3 px-3 py-2 transition-colors"
                >
                  <span className="mono-data min-w-0 flex-1 truncate text-xs">
                    {b.image ?? b.commit ?? b.id}
                  </span>
                  <StatusBadge tone={buildTone(b.status)} label={b.status} />
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
