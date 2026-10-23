import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BucketDetailView } from '@swarmy/core';
import { Button, Input, cn, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { MintedKey } from './secret-once';

const PERMS = [
  { id: 'rw', label: 'Read & write', read: true, write: true },
  { id: 'ro', label: 'Read only', read: true, write: false },
] as const;

/**
 * A new key for this bucket: `buckets.createKey` (the secret comes back once)
 * then `buckets.grantKeyOnBucket` for read-write or read.
 */
export function NewBucketKey({ bucket: b, onMinted, onCancel }: { bucket: BucketDetailView; onMinted: (k: MintedKey) => void; onCancel: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [perm, setPerm] = React.useState<(typeof PERMS)[number]['id']>('rw');
  const create = useMutation(trpc.buckets.createKey.mutationOptions());
  const grant = useMutation(trpc.buckets.grantKeyOnBucket.mutationOptions());
  const pending = create.isPending || grant.isPending;

  const go = async (): Promise<void> => {
    const p = PERMS.find((x) => x.id === perm)!;
    try {
      const k = await create.mutateAsync({ name: name.trim() });
      // The secret is in hand from here: show it even if the grant fails.
      try {
        await grant.mutateAsync({ bucketId: b.id, accessKeyId: k.accessKeyId, permissions: { read: p.read, write: p.write, owner: false }, mode: 'allow' });
      } catch (e) {
        toast.error(`Key made, but not given access: ${e instanceof Error ? e.message : String(e)}`);
      }
      onMinted({ accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, name: k.name });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      void qc.invalidateQueries();
    }
  };

  return (
    <form
      className="bg-background flex flex-col gap-3 rounded-xl border p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 flex-1 basis-48 gap-1.5">
          <span className="text-muted-foreground text-xs font-semibold">Who is it for?</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-upload" className="mono-data" autoFocus autoComplete="off" spellCheck={false} />
        </label>
        <div role="radiogroup" aria-label="What it may do" className="border-border inline-flex gap-0.5 rounded-[10px] border p-0.5">
          {PERMS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={perm === p.id}
              onClick={() => setPerm(p.id)}
              className={cn('h-8 rounded-[8px] px-3 text-[13px] font-semibold pointer-coarse:min-h-11', perm === p.id ? 'bg-surface-2 dark:bg-accent' : 'text-muted-foreground hover:text-foreground')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <Tech>buckets.createKey → buckets.grantKeyOnBucket {b.name} {perm === 'rw' ? 'read+write' : 'read'}</Tech>
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={pending || !name.trim()}>
          {pending ? 'Making it…' : 'Make the key'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
