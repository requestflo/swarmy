import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { swapProblem, type SearchIndexView, type SearchInstanceView } from '@swarmy/core';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Input,
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const short = (svc: string): string => svc.replace(/^[^_]*_/, '');

/**
 * Reindex by swap (board 41). swarmy doesn't hold the app's data, so it
 * can't rebuild an index from the database; the app writes a full rebuild
 * into a second index and swarmy swaps it in atomically (`search.swapIndex`,
 * the engine's swap-index pattern). Typed confirmation; audited.
 */
export function SearchReindexDialog({
  v,
  live,
  indexes,
  onSwapped,
}: {
  v: SearchInstanceView;
  live: SearchIndexView;
  indexes: SearchIndexView[];
  /** The live index after a swap (keep it picked). */
  onSwapped?: (uid: string) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const others = indexes.filter((i) => i.uid !== live.uid);
  const [withUid, setWith] = React.useState<string>('');
  const [confirm, setConfirm] = React.useState('');
  const next = others.find((i) => i.uid === withUid) ?? others.find((i) => i.uid.startsWith(live.uid)) ?? others[0];
  const problem = next ? swapProblem(live, next) : null;
  const app = v.attachments.map((a) => short(a.service))[0] ?? 'your app';
  const swap = useMutation(
    trpc.search.swapIndex.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.status === 'succeeded' ? `${r.index} now answers from the rebuild. The old documents are in ${r.with}.` : `Swapping ${r.index} and ${r.with} (engine task ${r.taskUid ?? '?'} is ${r.status})`);
        void qc.invalidateQueries({ queryKey: trpc.search.indexes.queryKey() });
        void qc.invalidateQueries({ queryKey: trpc.search.index.queryKey() });
        setOpen(false);
        onSwapped?.(r.index);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setConfirm('');
      }}
    >
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost">
          Reindex…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reindex {live.uid} by swapping in a rebuild</AlertDialogTitle>
          <AlertDialogDescription>
            swarmy doesn’t hold {app}’s data, so it can’t rebuild {live.uid} from your database. Have {app} (or a one-off job) write
            every document into a second index here, then swap it in: searches answer from the old documents until the swap
            lands, and never from an empty index.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {others.length === 0 || !next ? (
          <p className="text-muted-foreground text-[13px]">
            No other index here yet. Step one is {app}’s: write into <code className="font-mono">{live.uid}_next</code>{' '}
            (<code className="font-mono text-[12px]">POST /indexes/{live.uid}_next/documents</code>), then come back.
          </p>
        ) : (
          <div className="grid gap-3">
            <label className="grid gap-1.5 text-[13px]">
              <span className="mono-label text-muted-foreground">Swap in</span>
              <select value={next.uid} onChange={(e) => setWith(e.target.value)} className="border-border bg-background h-9 rounded-[8px] border px-2 font-mono text-[13px] pointer-coarse:min-h-11">
                {others.map((i) => (
                  <option key={i.uid} value={i.uid}>
                    {i.uid} · {i.docs.toLocaleString()} documents
                  </option>
                ))}
              </select>
            </label>
            <p className={problem ? 'text-tone-warn text-[12.5px]' : 'text-muted-foreground text-[12.5px]'}>
              {problem ??
                `${live.uid} has ${live.docs.toLocaleString()} documents; ${next.uid} has ${next.docs.toLocaleString()}. A swap moves settings with the documents, so give ${next.uid} the same searchable fields, filters and synonyms first. Afterwards the old documents are in ${next.uid}: swap back, or delete it from ${app}.`}
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="swap-confirm" className="mono-label">
                Type <code className="mono-data">{live.uid}</code> to swap
              </Label>
              <Input id="swap-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={live.uid} autoComplete="off" />
            </div>
            <p className="text-muted-foreground font-mono text-[11px]">POST /swap-indexes [{`{"indexes":["${live.uid}","${next.uid}"]}`}] — Meilisearch, inside {v.service}</p>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          {next ? (
            <Button
              disabled={!!problem || confirm !== live.uid || swap.isPending}
              onClick={() => swap.mutate({ stack: v.stack, name: v.name, index: live.uid, with: next.uid, confirm })}
            >
              {swap.isPending ? 'Swapping…' : `Swap in ${next.uid}`}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
