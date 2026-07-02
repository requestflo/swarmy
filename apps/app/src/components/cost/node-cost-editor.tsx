import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PencilIcon } from 'lucide-react';
import { Input, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Inline monthly-cost editor for one node row. Click the price (or "Set cost")
 * → an input; Enter/blur saves via cost.setNodeCost, Escape cancels. Empty
 * input clears the price (removes the label).
 */
export function NodeCostEditor({
  nodeId,
  monthlyUsd,
}: {
  nodeId: string;
  monthlyUsd: number | null;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  const save = useMutation(
    trpc.cost.setNodeCost.mutationOptions({
      onSuccess: () => {
        setEditing(false);
        void qc.invalidateQueries();
      },
    }),
  );

  const begin = (): void => {
    setDraft(monthlyUsd != null ? String(monthlyUsd) : '');
    setEditing(true);
  };

  const commit = (): void => {
    const trimmed = draft.trim();
    const n = trimmed === '' ? null : Number(trimmed);
    if (n !== null && (!Number.isFinite(n) || n < 0)) return; // keep editing invalid input
    if (n === monthlyUsd) {
      setEditing(false);
      return;
    }
    save.mutate({ nodeId, monthlyUsd: n });
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground text-sm">$</span>
        <Input
          autoFocus
          inputMode="decimal"
          value={draft}
          disabled={save.isPending}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="mono-data h-8 w-24 text-right"
          aria-label="Monthly cost in USD"
          placeholder="0"
        />
        <span className="text-muted-foreground text-xs">/mo</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={begin}
      className={cn(
        'group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm transition-colors',
        monthlyUsd != null
          ? 'mono-data hover:bg-accent font-semibold'
          : 'text-primary hover:bg-primary/10 font-bold',
      )}
    >
      {monthlyUsd != null ? `$${monthlyUsd}/mo` : 'Set cost'}
      <PencilIcon className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
    </button>
  );
}
