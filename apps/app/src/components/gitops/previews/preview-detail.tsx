import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, Trash2Icon } from 'lucide-react';
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
import { Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { AppPreview, GitApp } from '../gitops-types';
import { sha7 } from '../plan-status';
import { PreviewDataFlow } from './preview-data-flow';
import { usePreviewData } from './use-preview-data';

/** The picked preview: where it lives, its data story, and tearing it down now. */
export function PreviewDetail({ app, preview }: { app: GitApp; preview: AppPreview }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const d = usePreviewData(app, preview);
  const name = preview.branch ?? `PR #${preview.pr}`;
  const teardown = useMutation(
    trpc.apps.teardownPreview.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.stack ?? name} is gone — its services and throwaway data`);
        void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Section
      title={<span className="font-mono text-[15px]">{name}</span>}
      hint={`${preview.stack} · ${sha7(preview.sha)}`}
      action={
        <span className="flex items-center gap-1.5">
          {preview.url ? (
            <Button asChild variant="ghost" size="sm" className="pointer-coarse:min-h-11">
              <a href={preview.url} target="_blank" rel="noreferrer">
                Open <ExternalLinkIcon className="size-3.5" />
              </a>
            </Button>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={teardown.isPending}>
                <Trash2Icon className="size-3.5" /> {teardown.isPending ? 'Tearing down…' : 'Tear down'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Tear down {name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Removes {preview.stack}: its services and its throwaway database, cache and bucket. Production isn’t touched. A new push
                  {preview.branch ? ' to the branch' : ' to the PR'} brings it back.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction onClick={() => teardown.mutate({ repoId: app.repoId, prNumber: preview.pr })}>Tear down</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </span>
      }
    >
      <h3 className="text-muted-foreground text-[12.5px]">{preview.data ? 'Preview with data' : 'Preview data'}</h3>
      <PreviewDataFlow preview={preview} d={d} />
    </Section>
  );
}
