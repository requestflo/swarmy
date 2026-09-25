import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BanIcon, XIcon } from 'lucide-react';
import { Button, Input } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, EmptyState } from '@/components/states';
import { useEmailMutationHandlers } from './use-email';

const REASON: Record<string, string> = { bounce: 'Hard bounce', complaint: 'Spam complaint', manual: 'Added by hand' };

/** Addresses swarmy won't send to: hard bounces, complaints, manual blocks. */
export function SuppressionsTab(): React.JSX.Element {
  const trpc = useTRPC();
  const [search, setSearch] = React.useState('');
  const [address, setAddress] = React.useState('');
  const list = useQuery({ ...trpc.email.suppressions.queryOptions({ search: search || undefined }), refetchInterval: 15_000 });
  const add = useMutation(trpc.email.addSuppression.mutationOptions(useEmailMutationHandlers('Address suppressed')));
  const remove = useMutation(trpc.email.removeSuppression.mutationOptions(useEmailMutationHandlers('Removed — mail to it goes out again')));
  return (
    <div className="calm-card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Search addresses" value={search} onChange={(e) => setSearch(e.target.value)} />
        <form
          className="ml-auto flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ address }, { onSuccess: () => setAddress('') });
          }}
        >
          <Input type="email" placeholder="someone@example.com" value={address} onChange={(e) => setAddress(e.target.value)} />
          <Button type="submit" variant="outline" disabled={!address || add.isPending}>
            Suppress
          </Button>
        </form>
      </div>
      {list.isPending ? (
        <div className="mt-4">
          <CardSkeleton />
        </div>
      ) : !list.data || list.data.length === 0 ? (
        <EmptyState icon={<BanIcon />} title="No suppressed addresses." description="Hard bounces and spam complaints land here automatically, so a bad address never hurts your reputation twice." />
      ) : (
        <div className="border-border divide-border mt-4 divide-y rounded-xl border">
          {list.data.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-2">
              <div className="min-w-0 flex-1">
                <p className="mono-data truncate text-sm">{s.address}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {REASON[s.reason] ?? s.reason} · {new Date(s.createdAt).toLocaleDateString()} {s.detail ? `· ${s.detail}` : ''}
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label={`Unsuppress ${s.address}`} disabled={remove.isPending} onClick={() => remove.mutate({ id: s.id })}>
                <XIcon className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
