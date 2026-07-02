import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PencilIcon } from 'lucide-react';
import type { ConfigFamilyView } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DiffView } from './diff-view';

/**
 * Edit = new version. Loads the current content into a monospace editor;
 * "Preview changes" shows a line diff against the current version before you
 * save it as v(n+1). Saving restarts nothing — Apply does that, explicitly.
 */
export function EditConfigDialog({ family }: { family: ConfigFamilyView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState(false);

  const current = useQuery({
    ...trpc.configs.content.queryOptions({ family: family.family }),
    enabled: open,
  });
  const base = current.data?.content ?? '';
  const value = draft ?? base;

  const save = useMutation(
    trpc.configs.newVersion.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          `${r.family} saved as v${r.version} — apply it when you're ready to restart consumers`,
        );
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setDraft(null);
      setPreview(false);
    }
  };

  const changed = draft !== null && draft !== base;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PencilIcon className="size-3.5" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {family.family}</DialogTitle>
          <DialogDescription>
            Saving creates <span className="mono-data">v{family.currentVersion + 1}</span>. Nothing
            restarts until you apply it — services keep reading v{family.currentVersion}.
          </DialogDescription>
        </DialogHeader>
        {current.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="shimmer-line h-8 rounded-lg" />
            ))}
          </div>
        ) : current.isError ? (
          <p className="text-status-offline text-sm">{current.error.message}</p>
        ) : preview ? (
          <DiffView oldText={base} newText={value} />
        ) : (
          <Textarea
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            className="mono-data max-h-96 min-h-64 whitespace-pre text-xs"
            spellCheck={false}
          />
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={current.isLoading || current.isError}
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? 'Back to editor' : 'Preview changes'}
          </Button>
          <Button
            onClick={() => save.mutate({ family: family.family, content: value })}
            disabled={!changed || value.length === 0 || save.isPending}
          >
            {save.isPending ? 'Saving…' : `Save as v${family.currentVersion + 1}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
