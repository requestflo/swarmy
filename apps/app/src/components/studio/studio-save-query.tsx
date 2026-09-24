import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlusIcon } from 'lucide-react';
import { Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { StudioScope } from './studio-types';

/** Save the console statement on this app (shared with everyone who can read the database). */
export function StudioSaveQuery({ scope, statement }: { scope: StudioScope; statement: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const save = useMutation(
    trpc.studio.saved.save.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Saved “${r.name}”`);
        setOpen(false);
        setName('');
        void qc.invalidateQueries({ queryKey: trpc.studio.saved.list.queryKey({ stack: scope.stack }) });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!open) {
    return (
      <div>
        <Button size="sm" variant="ghost" disabled={!statement.trim()} onClick={() => setOpen(true)}>
          <BookmarkPlusIcon className="size-3.5" /> Save query
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) save.mutate({ stack: scope.stack, target: scope.target.name, engine: scope.target.engine, name: name.trim(), statement });
      }}
    >
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Revenue last 7 days" className="h-8 max-w-xs" autoFocus />
      <Button size="sm" type="submit" variant="outline" disabled={!name.trim() || save.isPending}>
        Save
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}
