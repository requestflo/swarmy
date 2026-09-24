import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRightIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { AppEnvironment } from './gitops-types';
import { envLabel, planStatus, shortDigest } from './plan-status';

interface PromoteDialogProps {
  repoId: string;
  env: AppEnvironment;
  /** Open the plan the promote produced (with where it came from). */
  onPlan: (planId: string, from: string) => void;
}

/** "Promote to production": production redeploys the exact images this environment runs. */
export function PromoteDialog({ repoId, env, onPlan }: PromoteDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const from = envLabel(env.environment).toLowerCase();
  const services = (env.latest?.plan?.actions ?? [])
    .filter((a) => a.kind === 'service.deploy' && a.name)
    .map((a) => a.name as string);
  const preview = useMutation(trpc.apps.promote.mutationOptions());
  const previewImages = preview.data ? Object.entries(preview.data.images) : [];
  const promote = useMutation(
    trpc.apps.promote.mutationOptions({
      onSuccess: (r) => {
        const images = Object.entries(r.images);
        toast.success(
          `Promoted ${from} to production — ${planStatus(r.status).label.toLowerCase()}.`,
          {
            description: images.length ? (
              <ul className="mono-data text-xs">
                {images.map(([svc, ref]) => (
                  <li key={svc}>
                    {svc} · {shortDigest(ref)}
                  </li>
                ))}
              </ul>
            ) : undefined,
          },
        );
        void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
        const id = r.plan?.id ?? r.planId;
        if (id) onPlan(id, env.environment);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (open) preview.mutate({ repoId, from: env.environment, dryRun: true });
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={promote.isPending}>
          <ArrowUpRightIcon className="size-4" />{' '}
          {promote.isPending ? 'Promoting…' : 'Promote to production'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Promote {from} to production?</AlertDialogTitle>
          <AlertDialogDescription>
            Production redeploys these exact images — no rebuild. Production’s swarmy.yaml still
            decides config; the next push to main returns it to git.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="bg-accent/40 space-y-1 rounded-xl px-4 py-3 text-sm">
          {previewImages.length ? (
            previewImages.map(([svc, ref]) => (
              <li key={svc} className="flex justify-between gap-3">
                <span className="mono-data">{svc}</span>
                <span className="text-muted-foreground mono-data">{shortDigest(ref)}</span>
              </li>
            ))
          ) : services.length ? (
            services.map((s) => (
              <li key={s} className="flex justify-between gap-3">
                <span className="mono-data">{s}</span>
                <span className="text-muted-foreground mono-label">as running on {from}</span>
              </li>
            ))
          ) : (
            <li>Every service, as running on {from}.</li>
          )}
          <li className="text-muted-foreground pt-1 text-xs">
            {preview.isPending
              ? 'Reading the exact digests…'
              : preview.isError
                ? `Couldn’t preview: ${preview.error.message}`
                : previewImages.length
                  ? 'These exact digests go to production.'
                  : 'Exact digests are listed once it’s done.'}
          </li>
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={() => promote.mutate({ repoId, from: env.environment })}>
            Promote
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
