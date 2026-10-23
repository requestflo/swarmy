import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Skeleton, toast } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { Segmented } from '@/components/domains/segmented';
import { useTRPC } from '@/integrations/trpc';

type Require2fa = 'off' | 'admins' | 'all';

const OPTIONS: Array<{ value: Require2fa; label: string }> = [
  { value: 'off', label: 'nobody' },
  { value: 'admins', label: 'admins' },
  { value: 'all', label: 'everyone' },
];

const WHO: Record<Exclude<Require2fa, 'off'>, string> = { admins: 'Owners and admins', all: 'Everyone' };

function requireLine(v: Require2fa, graceDays: number): string {
  if (v === 'off') return 'Nobody is forced: two-factor is each person’s choice.';
  const when = graceDays === 0 ? 'before they can carry on' : `within ${graceDays} day${graceDays === 1 ? '' : 's'}`;
  return `${WHO[v]} who sign in with a password must add an authenticator app ${when}.`;
}

/**
 * The one org-level 2FA knob: who must add an authenticator app — nobody (the
 * default), owners and admins, or everyone. Only password accounts are asked:
 * people who sign in through SSO or a social account are never asked, their
 * identity provider owns MFA (and many of them have no email to recover a
 * password account with).
 */
export function Require2faCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policy = useQuery(trpc.security.policy.get.queryOptions());
  const save = useMutation(
    trpc.security.policy.set.mutationOptions({
      onSuccess: (p) => {
        toast.success(
          p.require2fa === 'off'
            ? 'Two-factor is optional again'
            : p.require2fa === 'admins'
              ? 'Two-factor is now required for owners and admins'
              : 'Two-factor is now required for everyone',
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Section title="Workspace two-factor">
      {!policy.data ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="grid gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-muted-foreground">Require two-factor for</span>
            <Segmented
              mono
              label="Require two-factor for"
              value={policy.data.require2fa}
              options={OPTIONS}
              disabled={save.isPending}
              onChange={(v) => save.mutate({ require2fa: v, trustIdpMfa: true, graceDays: policy.data?.graceDays ?? 7 })}
            />
          </div>
          <p>{requireLine(policy.data.require2fa, policy.data.graceDays)}</p>
          <p className="text-muted-foreground">
            Anyone signing in with SSO or a social account is never asked; their provider handles MFA.
          </p>
          <Tech>require2fa: {policy.data.require2fa} · graceDays: {policy.data.graceDays} · trustIdpMfa: true</Tech>
        </div>
      )}
    </Section>
  );
}
