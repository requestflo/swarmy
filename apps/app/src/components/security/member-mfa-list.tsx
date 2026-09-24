import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton, StatusBadge, toast, type StatusTone } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const STANDING: Record<string, { tone: StatusTone; label: (deadline: Date | null) => string }> = {
  enrolled: { tone: 'online', label: () => 'Enrolled' },
  exempt_sso: { tone: 'neutral', label: () => 'Exempt (SSO)' },
  not_required: { tone: 'neutral', label: () => 'Not required' },
  grace: { tone: 'warning', label: (d) => (d ? `Grace, due ${d.toLocaleDateString()}` : 'Grace') },
  blocked: { tone: 'offline', label: () => 'Blocked, must enrol' },
};

/** Every member's 2FA standing, with an admin reset for a lost authenticator. */
export function MemberMfaList(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const members = useQuery(trpc.security.members.queryOptions());
  const reset = useMutation(
    trpc.security.resetMember.mutationOptions({
      onSuccess: () => {
        toast.success('Two-factor reset. They have been signed out and can enrol again.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const [confirming, setConfirming] = React.useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Members</CardTitle>
      </CardHeader>
      <CardContent>
        {!members.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <ul className="divide-border divide-y">
            {members.data.map((m) => {
              const s = STANDING[m.standing] ?? STANDING.not_required!;
              return (
                <li key={m.memberId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{m.name || m.email}</div>
                    <div className="text-muted-foreground truncate text-xs">
                      {m.email} · {m.role}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge tone={s.tone} label={s.label(m.deadline ? new Date(m.deadline) : null)} />
                    {m.enrolled &&
                      (confirming === m.memberId ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={reset.isPending}
                          onClick={() => reset.mutate({ memberId: m.memberId })}
                        >
                          Confirm reset
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => setConfirming(m.memberId)}>
                          Reset 2FA
                        </Button>
                      ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
