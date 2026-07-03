import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TagIcon } from 'lucide-react';
import { Button, Label, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Internal swarmy.* labels have dedicated controls — hide them from this free-form editor. */
function isCustomLabel(key: string): boolean {
  return !key.startsWith('swarmy.');
}

function labelsToText(labels: Record<string, string>): string {
  return Object.entries(labels)
    .filter(([k]) => isCustomLabel(k))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function parseLabelLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

interface NodeLabelsEditorProps {
  nodeId: string;
  labels: Record<string, string>;
}

/** Custom Docker node labels (`key=value` per line) — no dialog, edits in place. */
export function NodeLabelsEditor({ nodeId, labels }: NodeLabelsEditorProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const initial = React.useMemo(() => labelsToText(labels), [labels]);
  const [text, setText] = React.useState(initial);

  React.useEffect(() => setText(initial), [initial]);

  const setLabels = useMutation(
    trpc.nodes.setLabels.mutationOptions({
      onSuccess: () => {
        toast.success('Labels saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const save = (): void => {
    const next = parseLabelLines(text);
    const prevKeys = Object.keys(parseLabelLines(initial));
    const patch: Record<string, string> = { ...next };
    // Merged labels can't be deleted — write '' for any custom key that was removed.
    for (const k of prevKeys) if (!(k in next)) patch[k] = '';
    setLabels.mutate({ id: nodeId, labels: patch });
  };

  return (
    <div className="grid gap-1.5">
      <Label className="mono-label flex items-center gap-1.5">
        <TagIcon className="size-3.5" /> Custom labels
      </Label>
      <Textarea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="team=platform&#10;disk=nvme"
        className="mono-data text-xs"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={text === initial || setLabels.isPending}
          onClick={save}
        >
          Save labels
        </Button>
      </div>
    </div>
  );
}
