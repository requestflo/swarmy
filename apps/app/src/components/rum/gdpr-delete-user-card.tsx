import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { RumSection, Segmented } from './rum-ui';

interface GdprDeleteUserCardProps {
  stack: string;
  disabled: boolean;
}

type Scope = 'app' | 'all';
const SCOPES: { value: Scope; label: string }[] = [
  { value: 'app', label: 'this app' },
  { value: 'all', label: 'every app' },
];

/** Right to erasure: every session, recording and analytics row for one user id. */
export function GdprDeleteUserCard({ stack, disabled }: GdprDeleteUserCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [userId, setUserId] = React.useState('');
  const [scope, setScope] = React.useState<Scope>('app');
  const [confirming, setConfirming] = React.useState(false);
  const del = useMutation(
    trpc.rum.deleteUser.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Erased ${r.sessions} session${r.sessions === 1 ? '' : 's'} and their analytics rows`);
        setUserId('');
        setConfirming(false);
        void qc.invalidateQueries({ queryKey: trpc.rum.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const id = userId.trim();

  return (
    <RumSection title="Delete everything for a user">
      <p className="text-muted-foreground text-sm">
        A GDPR erasure request: removes every recording, replay index row and analytics row tied to this
        user id. It can't be undone.
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (id) setConfirming(true);
        }}
      >
        <Input
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setConfirming(false);
          }}
          placeholder="user id, e.g. usr_7f2a19"
          aria-label="User id to erase"
          disabled={disabled}
          className="h-8 max-w-xs font-mono text-xs"
        />
        <Segmented label="Erase from" value={scope} options={SCOPES} onChange={setScope} disabled={disabled} />
        {!confirming ? (
          <Button type="submit" size="sm" variant="outline" disabled={disabled || !id} className="border-status-offline/40 text-status-offline rounded-full font-bold">
            Delete…
          </Button>
        ) : (
          <span role="alert" className="flex items-center gap-2 text-xs">
            <b>Erase {id} from {scope === 'app' ? stack : 'every app'}?</b>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={del.isPending}
              onClick={() => del.mutate({ userId: id, stack: scope === 'app' ? stack : undefined })}
              className="border-status-offline text-status-offline h-7 rounded-full font-bold"
            >
              {del.isPending ? 'Erasing…' : 'Erase for good'}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 rounded-full" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        )}
      </form>
    </RumSection>
  );
}
