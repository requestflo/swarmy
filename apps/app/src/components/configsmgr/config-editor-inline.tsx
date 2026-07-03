import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigFamilyView } from '@swarmy/core';
import { Button, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DiffView } from './diff-view';

interface ConfigEditorInlineProps {
  family: ConfigFamilyView;
  onDone: () => void;
}

/**
 * Inline editor (replaces the edit dialog): loads the current content, diffs
 * the draft against it, and saves as v(n+1). Saving restarts nothing — Apply
 * does that, explicitly, with its own restart preview.
 */
export function ConfigEditorInline({ family, onDone }: ConfigEditorInlineProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState(false);

  const current = useQuery(trpc.configs.content.queryOptions({ family: family.family }));
  const base = current.data?.content ?? '';
  const value = draft ?? base;
  const changed = draft !== null && draft !== base;

  const save = useMutation(
    trpc.configs.newVersion.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          `${r.family} saved as v${r.version} — apply it when you're ready to restart consumers`,
        );
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">
        Editing · saves as v{family.currentVersion + 1}
      </p>
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
          className="mono-data bg-card max-h-96 min-h-48 whitespace-pre text-xs"
          spellCheck={false}
        />
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={current.isLoading || current.isError}
          onClick={() => setPreview((p) => !p)}
        >
          {preview ? 'Back to editor' : 'Preview changes'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => save.mutate({ family: family.family, content: value })}
          disabled={!changed || value.length === 0 || save.isPending}
        >
          {save.isPending ? 'Saving…' : `Save as v${family.currentVersion + 1}`}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Nothing restarts on save — services keep reading v{family.currentVersion} until you apply.
      </p>
    </section>
  );
}
