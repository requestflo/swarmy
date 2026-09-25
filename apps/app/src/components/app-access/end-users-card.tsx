import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, UserRoundXIcon } from 'lucide-react';
import { Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import type { EndUserAuth } from './types';

interface EndUsersCardProps {
  stack: string;
  auth: EndUserAuth;
}

/** `auth:` in swarmy.yaml — the app's OWN users (its customers), its providers, and disable. */
export function EndUsersCard({ stack, auth }: EndUsersCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const users = useQuery({ ...trpc.appAccess.users.queryOptions({ stack }), enabled: auth.running, retry: 0 });
  const toggle = useMutation(
    trpc.appAccess.setUserDisabled.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.disabled ? 'User disabled and signed out.' : 'User enabled.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-4">
      <div>
        <h2 className="say text-xl">
          App <em>users</em>
        </h2>
        <p className="text-muted-foreground mono-label mt-1">
          {auth.providers.length ? auth.providers.join(' · ') : 'no social providers'} · email {auth.email} · {auth.database}
        </p>
      </div>

      {auth.providerSetup.length ? (
        <div className="calm-card shadow-none divide-border divide-y overflow-hidden">
          {auth.providerSetup.map((p) => (
            <div key={p.provider} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-sm">
              <KeyRoundIcon className="text-muted-foreground size-4" />
              <span className="font-semibold capitalize">{p.provider}</span>
              <span className="mono-data text-muted-foreground">secrets {p.secrets.join(', ')}</span>
              {p.callbackUrl ? <span className="mono-data text-muted-foreground">redirect URI {p.callbackUrl}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {!auth.running ? (
        <div className="calm-card shadow-none p-2">
          <EmptyState icon={<KeyRoundIcon />} title="The auth service isn't running yet" description="It starts with the app's next deploy." />
        </div>
      ) : users.isPending ? (
        <CardSkeleton lines={3} />
      ) : users.isError ? (
        <ErrorState title="Couldn't reach the app's auth service." error={users.error} retry={() => void users.refetch()} />
      ) : users.data.users.length === 0 ? (
        <div className="calm-card shadow-none p-2">
          <EmptyState icon={<KeyRoundIcon />} title="No one has signed up yet" description="Send people to /auth/login on the app's domain." />
        </div>
      ) : (
        <div className="calm-card shadow-none divide-border divide-y overflow-hidden">
          {users.data.users.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <span className="min-w-0">
                <span className="block truncate font-medium">{u.email}</span>
                <span className="text-muted-foreground mono-label">{u.name || 'no name'} · joined {new Date(u.createdAt).toLocaleDateString()}</span>
              </span>
              <span className="flex items-center gap-3">
                <StatusBadge tone={u.disabled ? 'offline' : 'online'} label={u.disabled ? 'Disabled' : 'Active'} />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ stack, userId: u.id, disabled: !u.disabled })}
                >
                  <UserRoundXIcon className="size-4" /> {u.disabled ? 'Enable' : 'Disable'}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
